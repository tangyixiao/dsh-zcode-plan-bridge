/** Read the existing v2 key through ZCode's own installed keyring module. No writes or exports to disk. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { ZCODE_CLI_CANDIDATES } from './zcode-runtime.js'

/** @typedef {{readOsKey?:(file:string)=>string|null}} KeyReadOptions */
/** @type {Map<string,Buffer>} */
const cache = new Map()
/** @returns {Error & {code:string}} */
function unavailable() { return Object.assign(new Error('ZCode v2 credential key is unavailable; use a compatible signed-in ZCode installation'), { code: 'CREDENTIAL_KEYSTORE' }) }

/** Load only the user's existing ZCode key entry; never enumerate or create entries.
 * @param {string} file @returns {string|null}
 */
function readOsKey(file) {
  const account = createHash('sha256').update(path.resolve(file)).digest('hex')
  for (const cli of ZCODE_CLI_CANDIDATES) {
    if (!fs.existsSync(cli)) continue
    const require = createRequire(path.resolve(cli))
    /** @type {any[]} */ const providers = []
    try { providers.push(require('@napi-rs/keyring')) } catch { /* Desktop ships the native binding in its unpacked resources. */ }
    const nativeRoot = path.join(path.dirname(path.dirname(cli)), 'app.asar.unpacked', 'node_modules', '@napi-rs')
    try {
      for (const pkg of fs.readdirSync(nativeRoot).filter(name => name.startsWith(`keyring-${process.platform}-`) && (name.includes(process.arch) || name.includes('universal'))).slice(0, 4)) {
        const directory = path.join(nativeRoot, pkg)
        for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.node')).slice(0, 2)) {
          try { providers.push(require(path.join(directory, name))) } catch { /* Architecture/libc mismatch is not a permission fallback. */ }
        }
      }
    } catch { /* This candidate has no desktop native binding. */ }
    for (const provider of providers) {
      if (typeof provider.Entry !== 'function') continue
      try {
        const value = new provider.Entry('ZCode Credential Encryption', account, { linux: { store: 'secret-service' } }).getPassword()
        if (typeof value === 'string' && value) return value
      } catch { /* Do not expose OS messages or try to create/reset an entry. */ }
    }
  }
  return null
}

/** @param {string} file @param {string} envelope @param {KeyReadOptions} [options] @returns {Buffer} */
export function readV2CredentialKey(file, envelope, options = {}) {
  const [source, fingerprint] = envelope.slice('enc:v2:'.length).split(':')
  if (!['os', 'env'].includes(source) || !/^[a-f0-9]{24}$/u.test(fingerprint ?? '')) throw unavailable()
  if (source === 'os' && (process.env.ZCODE_CREDENTIAL_SECRET || process.env.ZCODE_CREDENTIAL_SECRET_FILE)) throw unavailable()
  const cacheId = JSON.stringify([path.resolve(file), source, fingerprint])
  if (source === 'os' && !options.readOsKey && cache.has(cacheId)) return /** @type {Buffer} */ (cache.get(cacheId))
  let key
  if (source === 'env') {
    if (process.env.ZCODE_CREDENTIAL_SECRET && process.env.ZCODE_CREDENTIAL_SECRET_FILE) throw unavailable()
    let secret = process.env.ZCODE_CREDENTIAL_SECRET
    if (!secret) {
      if (!process.env.ZCODE_CREDENTIAL_SECRET_FILE) {
        try { if (fs.readFileSync(path.join(path.dirname(file), 'credential-source'), 'utf8') === 'os\n') throw unavailable() }
        catch (error) { if (/** @type {any} */ (error)?.code !== 'ENOENT') throw unavailable() }
      }
      const secretFile = process.env.ZCODE_CREDENTIAL_SECRET_FILE || path.join(path.dirname(file), 'credential-secret')
      try {
        const stat = fs.statSync(secretFile)
        if (!stat.isFile() || stat.size < 32 || stat.size > 4096 || (!process.env.ZCODE_CREDENTIAL_SECRET_FILE && process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw unavailable()
        secret = fs.readFileSync(secretFile, 'utf8')
      } catch { throw unavailable() }
    }
    key = createHash('sha256').update(secret).digest()
  } else {
    if (process.env.ZCODE_CREDENTIAL_SECRET || process.env.ZCODE_CREDENTIAL_SECRET_FILE) throw unavailable()
    const encoded = (options.readOsKey ?? readOsKey)(file)
    if (typeof encoded !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(encoded)) throw unavailable()
    key = Buffer.from(encoded, 'base64url')
  }
  if (key.length !== 32 || createHash('sha256').update(key).digest('hex').slice(0, 24) !== fingerprint) throw unavailable()
  if (source === 'os' && !options.readOsKey) {
    if (cache.size >= 8) { const first = cache.keys().next().value; if (first !== undefined) { cache.get(first)?.fill(0); cache.delete(first) } }
    cache.set(cacheId, key)
  }
  return key
}
