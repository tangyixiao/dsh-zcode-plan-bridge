/**
 * ZCode 客户端共享凭证的解密（读取 Start Plan 的 OAuth token）。
 *
 * zcode.cjs 的凭证存储（~/.zcode/v2/credentials.json）：
 *   - 新版 enc:v2:<os|env>:<key fingerprint>:<iv>.<tag>.<data> 使用既有系统密钥或显式密钥源。
 *   - 只读现有密钥，不生成、重置、迁移或导出凭证；未知 enc 版本禁止当作明文使用。
 *   - 每个值形如 `enc:v1:<iv>.<tag>.<data>`（base64url 三段）
 *   - AES-256-GCM，密钥 = SHA-256(ZCODE_CREDENTIAL_SECRET ?? 机器指纹)
 *   - 机器指纹 = `zcode-credential-fallback:<platform>:<homedir>:<username>`
 *     （与 zcode.cjs 的 resolveCredentialSecret 完全一致）
 *
 * 关联凭证键（2026-09-30 实测）：
 *   - `zcodejwttoken`：ZCode JWT —— **Start Plan 端点的鉴权凭证**（requestAuth.apiKey 用它，
 *     agent 在其上计算 coding-plan 请求签名）。`oauth:zai:access_token` 是 OAuth 会话 token，
 *     长期不刷新已过期（401），只作兜底。
 *   - `oauth:zai:access_token`：Z.AI OAuth 会话 token（已过期的兜底）
 *   - `oauth:active_provider`：当前登录的家族（"zai" | "bigmodel"）
 *
 * @module lib/credentials
 */

import { createDecipheriv, createHash } from 'node:crypto'
import { userInfo, platform, homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { readV2CredentialKey } from './credential-key.js'

const ENC_PREFIX = 'enc:v1:'
const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const TAG_LENGTH = 16

/** 凭证读取/解密失败的错误码（稳定的机读值，调用方按 code 分流）。 */
export const CREDENTIAL_ERROR_CODES = /** @type {const} */ ([
  'CIPHER_FORMAT',
  'CIPHER_IV',
  'CIPHER_TAG',
  'CIPHER_DECRYPT',
  'CREDENTIALS_MISSING',
  'CREDENTIALS_READ',
  'TOKEN_MISSING',
  'CIPHER_VERSION',
  'CIPHER_KEY',
  'CREDENTIAL_KEYSTORE',
])

/**
 * 从共享凭证里提取的 Start Plan 鉴权。
 *
 * @typedef {object} ZaiPlanAuth
 * @property {string} planToken `zcodejwttoken`（Start Plan 端点的 x-api-key）。
 * @property {string} [accessToken] 已过期的 `oauth:zai:access_token`，仅兜底。
 * @property {string} [activeProvider] 当前登录家族，通常为 `'zai'`。
 */

/** 单个凭证值；`null` 表示该值解密失败。 @typedef {string | null} CredentialValue */

/** 凭证读取/解密失败（可恢复，调用方按 `code` 分流）。 */
export class CredentialError extends Error {
  /**
   * @param {string} message 人类可读的失败描述。
   * @param {typeof CREDENTIAL_ERROR_CODES[number]} code 稳定的机读错误码。
   */
  constructor(message, code) {
    super(message)
    this.name = 'CredentialError'
    this.code = code
  }
}

/**
 * 复刻 zcode.cjs resolveCredentialSecret 的机器指纹。
 *
 * @param {string} [secretOverride] 测试覆盖（ZCODE_CREDENTIAL_SECRET）。
 * @returns {string} 参与 AES 密钥派生的原始密钥材料。
 */
export function credentialSecret(secretOverride) {
  const fromEnv = secretOverride ?? process.env.ZCODE_CREDENTIAL_SECRET
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  let username = 'unknown'
  try {
    username = userInfo().username
  } catch {
    /* 用户名不可得时与 zcode.cjs 一致地降级 */
  }
  return `zcode-credential-fallback:${platform()}:${homedir()}:${username}`
}

/**
 * AES-256-GCM 密钥（SHA-256 摘要，与 zcode.cjs 的 deriveCipherKey 一致）。
 *
 * @param {string} [secret] 密钥材料，默认取 {@link credentialSecret}。
 * @returns {Buffer} 32 字节密钥。
 */
export function deriveKey(secret = credentialSecret()) {
  return createHash('sha256').update(secret).digest()
}

/**
 * 解密单个 `enc:v1:` 值；非加密值原样返回。
 *
 * @param {unknown} value 存储中的凭证值。
 * @param {Buffer} [key] AES 密钥，默认取 {@link deriveKey}。
 * @returns {CredentialValue} 解密后的文本；未加密时原样返回。
 * @throws {CredentialError} 密文信封不合法时抛出。
 */
export function decryptValue(value, key = deriveKey()) {
  if (typeof value !== 'string') return /** @type {any} */ (value)
  let payload
  if (value.startsWith('enc:v2:')) {
    const fields = value.slice('enc:v2:'.length).split(':')
    if (fields.length !== 3 || !['os', 'env'].includes(fields[0]) || !/^[a-f0-9]{24}$/u.test(fields[1])) throw new CredentialError('凭证 v2 格式无效', 'CIPHER_FORMAT')
    if (createHash('sha256').update(key).digest('hex').slice(0, 24) !== fields[1]) throw new CredentialError('凭证密钥与指纹不匹配', 'CIPHER_KEY')
    payload = fields[2]
  } else if (value.startsWith(ENC_PREFIX)) payload = value.slice(ENC_PREFIX.length)
  else if (value.startsWith('enc:')) throw new CredentialError('当前凭证加密版本不受支持', 'CIPHER_VERSION')
  else return value
  const parts = payload.split('.')
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]*$/u.test(part))) {
    throw new CredentialError('凭证密文格式无效（应为 iv.tag.data 三段）', 'CIPHER_FORMAT')
  }
  const [ivB64, tagB64, dataB64] = parts
  const iv = Buffer.from(ivB64, 'base64url')
  const tag = Buffer.from(tagB64, 'base64url')
  const data = Buffer.from(dataB64, 'base64url')
  if (iv.length !== IV_LENGTH) {
    throw new CredentialError(`凭证 IV 长度无效（${iv.length} ≠ ${IV_LENGTH}）`, 'CIPHER_IV')
  }
  if (tag.length !== TAG_LENGTH) {
    throw new CredentialError(`凭证 auth tag 长度无效（${tag.length} ≠ ${TAG_LENGTH}）`, 'CIPHER_TAG')
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  } catch (/** @type {any} */ error) {
    throw new CredentialError(`凭证解密失败：${error?.message ?? error}`, 'CIPHER_DECRYPT')
  }
}

/**
 * 共享凭证文件路径（`~/.zcode/v2/credentials.json`）。
 *
 * @param {string} [dataBaseDir] ZCode 数据根目录；空串视为未设置。
 * @returns {string} 凭证文件绝对路径。
 */
export function credentialsPath(dataBaseDir) {
  // 空串视为未设置（path.join('', '.zcode', …) 会得到相对路径）
  const base = dataBaseDir?.trim?.() || process.env.ZCODE_DATA_BASE_DIR?.trim() || homedir()
  return path.join(base, '.zcode', 'v2', 'credentials.json')
}

/**
 * 读取并解密共享凭证。
 *
 * @param {string} [dataBaseDir] ZCode 数据根目录。
 * @param {Buffer} [key] Explicit test/legacy key; otherwise resolve the stored envelope version.
 * @param {import('./credential-key.js').KeyReadOptions} [options] Read-only key-store seam.
 * @returns {Record<string, CredentialValue>} 键 → 解密后的值（未加密值原样保留，解密失败记 null）。
 * @throws {CredentialError} 文件缺失或无法解析时抛出。
 */
export function readCredentials(dataBaseDir, key, options = {}) {
  const file = credentialsPath(dataBaseDir)
  /** @type {Record<string, unknown>} */
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (/** @type {any} */ error) {
    if (error?.code === 'ENOENT') {
      throw new CredentialError(`共享凭证文件不存在：${file}（ZCode 客户端未登录？）`, 'CREDENTIALS_MISSING')
    }
    throw new CredentialError(`共享凭证文件读取失败：${error?.message ?? error}`, 'CREDENTIALS_READ')
  }
  /** @type {Record<string, CredentialValue>} */
  const out = {}
  const firstV2 = Object.values(raw).find(value => typeof value === 'string' && value.startsWith('enc:v2:'))
  let v2Key = key
  if (!v2Key && typeof firstV2 === 'string') {
    try { v2Key = readV2CredentialKey(file, firstV2, options) }
    catch { throw new CredentialError('无法读取 ZCode v2 的现有系统凭证密钥；不会重置或迁移登录', 'CREDENTIAL_KEYSTORE') }
  }
  const legacyKey = key ?? deriveKey()
  for (const [entryKey, entryValue] of Object.entries(raw)) {
    try {
      out[entryKey] = decryptValue(entryValue, typeof entryValue === 'string' && entryValue.startsWith('enc:v2:') ? v2Key : legacyKey)
    } catch {
      // 单个凭证解密失败不影响其他（记为 null，调用方按需判空）
      out[entryKey] = null
    }
  }
  return out
}

/**
 * 提取 Start Plan 请求需要的鉴权。
 *
 * planToken 优先用 `zcodejwttoken`，缺失时回退已过期的 `oauth:zai:access_token`。
 *
 * @param {string} [dataBaseDir] ZCode 数据根目录。
 * @param {Buffer} [key] AES 密钥，默认取 {@link deriveKey}。
 * @param {import('./credential-key.js').KeyReadOptions} [options] Read-only key-store seam.
 * @returns {ZaiPlanAuth} Start Plan 鉴权三元组。
 * @throws {CredentialError} 两个 token 都不存在时抛出。
 */
export function readZaiPlanAuth(dataBaseDir, key, options = {}) {
  const creds = readCredentials(dataBaseDir, key, options)
  const planToken = creds['zcodejwttoken']
  const accessToken = creds['oauth:zai:access_token']
  const hasPlan = typeof planToken === 'string' && planToken !== ''
  const hasAccess = typeof accessToken === 'string' && accessToken !== ''
  if (!hasPlan && !hasAccess) {
    throw new CredentialError(
      '共享凭证里没有 zcodejwttoken / oauth:zai:access_token（ZCode 客户端未登录 Z.AI？）',
      'TOKEN_MISSING',
    )
  }
  const activeProvider = creds['oauth:active_provider']
  return {
    planToken: hasPlan ? /** @type {string} */ (planToken) : /** @type {string} */ (accessToken),
    ...(hasAccess ? { accessToken: /** @type {string} */ (accessToken) } : {}),
    ...(typeof activeProvider === 'string' ? { activeProvider } : {}),
  }
}
