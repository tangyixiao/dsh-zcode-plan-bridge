/** Account-generation scoped preferences and content-free bounded observations. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { credentialsPath, readCredentials } from './credentials.js'
import { resolveCommunityRetry } from './community-retry.js'

/** @typedef {{revision:string, hiddenModels:string[], reasoning:Record<string,string>, retry:Record<string,any>|null, authorizationPolicy:'deny'|'allow-all'|null}} ToolkitPreferences */
const MAX_BYTES = 262144
const RETRY_FIELDS = ['enabled', 'mode', 'intervalMs', 'maxRetries', 'baseDelayMs', 'maxDelayMs', 'backoffFactor', 'jitter', 'budgetMs']
/** @param {string} code @returns {Error & {code:string}} */
export function toolkitError(code) { return Object.assign(new Error(code), { code }) }
/** @param {any} value @returns {boolean} */
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
/** @returns {ToolkitPreferences} */
function defaults() { return { revision: 'initial', hiddenModels: [], reasoning: {}, retry: null, authorizationPolicy: null } }
/** @param {any} value @returns {boolean} */
function modelId(value) { return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value) }
/** @param {any} patch @returns {void} */
export function validateSettingsPatch(patch) {
  if (!object(patch) || Object.keys(patch).some(key => !['hiddenModels', 'reasoning', 'retry', 'authorizationPolicy'].includes(key))) throw toolkitError('invalid-settings')
  if ('hiddenModels' in patch && (!Array.isArray(patch.hiddenModels) || patch.hiddenModels.length > 256 || !patch.hiddenModels.every(modelId) || new Set(patch.hiddenModels).size !== patch.hiddenModels.length)) throw toolkitError('invalid-settings')
  if ('reasoning' in patch && (!object(patch.reasoning) || Object.keys(patch.reasoning).length > 256 || !Object.entries(patch.reasoning).every(([id, effort]) => modelId(id) && typeof effort === 'string' && /^[a-z0-9_-]{1,32}$/iu.test(effort)))) throw toolkitError('invalid-settings')
  if ('authorizationPolicy' in patch && ![null, 'deny', 'allow-all'].includes(patch.authorizationPolicy)) throw toolkitError('invalid-settings')
  if ('retry' in patch && patch.retry !== null) {
    if (!object(patch.retry) || Object.keys(patch.retry).some(key => !RETRY_FIELDS.includes(key))) throw toolkitError('invalid-settings')
    try { resolveCommunityRetry(patch.retry) } catch { throw toolkitError('invalid-settings') }
  }
}

export class ToolkitSettingsStore {
  /** @param {string} file */
  constructor(file) { this.file = file }
  /** @returns {{version:1, scopes:Record<string,ToolkitPreferences>}} */
  document() {
    try {
      const handle = fs.openSync(this.file, 'r')
      let bytes
      try { if (fs.fstatSync(handle).size > MAX_BYTES) throw toolkitError('invalid-storage'); bytes = Buffer.alloc(MAX_BYTES + 1); bytes = bytes.subarray(0, fs.readSync(handle, bytes)) } finally { fs.closeSync(handle) }
      if (bytes.length > MAX_BYTES) throw toolkitError('invalid-storage')
      const value = JSON.parse(bytes.toString('utf8'))
      if (value?.version !== 1 || !object(value.scopes) || Object.keys(value.scopes).length > 64) throw toolkitError('invalid-storage')
      for (const [scope, settings] of Object.entries(value.scopes)) {
        if (!/^[a-f0-9]{64}$/u.test(scope) || !object(settings)) throw toolkitError('invalid-storage')
        const { revision, ...patch } = /** @type {any} */ (settings)
        if (typeof revision !== 'string' || !/^[a-f0-9-]{36}$/u.test(revision)) throw toolkitError('invalid-storage')
        validateSettingsPatch(patch)
        if (!['hiddenModels', 'reasoning', 'retry', 'authorizationPolicy'].every(key => key in patch)) throw toolkitError('invalid-storage')
      }
      return value
    } catch (error) {
      if (/** @type {any} */ (error)?.code === 'ENOENT') return { version: 1, scopes: {} }
      throw toolkitError('invalid-storage')
    }
  }
  /** @param {string} scope @returns {ToolkitPreferences} */
  read(scope) {
    if (!/^[a-f0-9]{64}$/u.test(scope)) throw toolkitError('invalid-scope')
    return structuredClone(this.document().scopes[scope] ?? defaults())
  }
  /** Synchronous critical section: other processes fail closed at the exclusive lock. @param {string} scope @param {string} revision @param {any} patch @returns {ToolkitPreferences} */
  update(scope, revision, patch) {
    validateSettingsPatch(patch)
    if (!/^[a-f0-9]{64}$/u.test(scope)) throw toolkitError('invalid-scope')
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    let lock
    try { lock = fs.openSync(this.file + '.lock', 'wx', 0o600) } catch { throw toolkitError('storage-busy') }
    const temp = this.file + '.' + randomUUID() + '.tmp'
    try {
      const document = this.document()
      const current = document.scopes[scope] ?? defaults()
      if (current.revision !== revision) throw toolkitError('stale-state')
      if (!(scope in document.scopes) && Object.keys(document.scopes).length >= 64) throw toolkitError('storage-full')
      const next = { ...current, ...structuredClone(patch), revision: randomUUID() }
      document.scopes[scope] = next
      const body = JSON.stringify(document)
      if (Buffer.byteLength(body) > MAX_BYTES) throw toolkitError('storage-full')
      const handle = fs.openSync(temp, 'wx', 0o600)
      try { fs.writeFileSync(handle, body); fs.fsyncSync(handle) } finally { fs.closeSync(handle) }
      fs.renameSync(temp, this.file)
      return structuredClone(next)
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp)
      fs.closeSync(lock); fs.unlinkSync(this.file + '.lock')
    }
  }
}

/** Conservative generation scope: no JWT identity claims are trusted. @param {any} options @returns {string} */
export function accountScope(options) {
  const file = credentialsPath(options.zcodeDataBaseDir)
  let identity = 'unavailable'
  try {
    const creds = readCredentials(options.zcodeDataBaseDir)
    identity = JSON.stringify(Object.entries(creds).filter(([key, value]) => typeof value === 'string' && /token|api.?key|active_provider/iu.test(key)).sort(([a], [b]) => a.localeCompare(b)))
  } catch { /* No account is a separate deterministic unavailable bucket. */ }
  return createHash('sha256').update(JSON.stringify([file, options.accountMode ?? 'standalone', identity])).digest('hex')
}

/** @param {any} error @returns {string} */
export function classifyFailure(error) {
  const code = String(error?.code ?? '')
  const detail = `${code} ${error instanceof Error ? error.message : typeof error === 'string' ? error : ''}`
  if (/ABORTED|AbortError|cancelled/iu.test(detail)) return 'cancelled'
  if (/TIMEOUT|timed?\s*out/iu.test(detail)) return 'timeout'
  if (/\b401\b|UNAUTHORIZED|invalid.?token|authentication/iu.test(detail)) return 'authentication'
  if (/\b405\b|\bESA\b|<html|channel|TRANSPORT|fetch failed|ECONN/iu.test(detail)) return 'channel'
  if (/\b429\b|RATE_LIMIT|concurrency|rate.?limit/iu.test(detail)) return 'throttled'
  if (/\b402\b|insufficient|out of credit|quota|balance/iu.test(detail)) return 'quota'
  if (/\b403\b|entitlement|not.?authorized|permission|policy/iu.test(detail)) return 'entitlement'
  return 'provider'
}

/** @typedef {{observedAt:number, model?:string, result:string, category?:string, usage?:Record<string,number>}} Observation */
export class ObservationLog {
  /** @param {number} [limit] */
  constructor(limit = 50) {
    this.limit = Math.max(1, Math.min(100, limit))
    /** @type {{scope:string, value:Observation}[]} */
    this.entries = []
  }
  /** @param {string} scope @param {any} result @returns {void} */
  record(scope, result) {
    /** @type {Record<string,number>} */ const usage = {}
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens']) {
      const value = result.usage?.[key]
      if (Number.isSafeInteger(value) && value >= 0) usage[key] = value
    }
    const value = { observedAt: Date.now(), ...(modelId(result.model) ? { model: result.model } : {}), result: ['success', 'failure', 'cancelled', 'incomplete'].includes(result.result) ? result.result : 'incomplete',
      ...(result.error === undefined ? {} : { category: classifyFailure(result.error) }), ...(Object.keys(usage).length ? { usage } : {}) }
    this.entries.push({ scope, value }); this.entries = this.entries.slice(-this.limit)
  }
  /** @param {string} scope @returns {Observation[]} */
  read(scope) { return structuredClone(this.entries.filter(entry => entry.scope === scope && Date.now() - entry.value.observedAt < 86_400_000).map(entry => entry.value).reverse()) }
  clear() { this.entries = [] }
}
