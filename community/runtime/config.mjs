export const VERSION = '0.1.0'
export const DEFAULTS = Object.freeze({
  maxRetries: 6, baseDelayMs: 5000, maxDelayMs: 60000, backoffFactor: 2,
  jitter: true, budgetMs: 600000, probeTimeoutMs: 30000,
  maxBodyBytes: 16 * 1024 * 1024, maxProbeBytes: 256 * 1024,
  allowedOrigins: ['https://zcode.z.ai', 'https://api.z.ai', 'https://open.bigmodel.cn'],
})

/** @param {any} raw @returns {any} */
export function resolveConfig(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Retry config must be an object')
  for (const key of Object.keys(raw)) if (!(key in DEFAULTS)) throw new Error(`Unknown retry option: ${key}`)
  /** @type {any} */
  const c = { ...DEFAULTS, ...raw }
  for (const [key, min, max] of [
    ['maxRetries', 0, 20], ['baseDelayMs', 0, 300000], ['maxDelayMs', 0, 300000],
    ['backoffFactor', 1, 10], ['budgetMs', 1, 3600000], ['probeTimeoutMs', 1, 300000],
    ['maxBodyBytes', 1, DEFAULTS.maxBodyBytes], ['maxProbeBytes', 1, DEFAULTS.maxProbeBytes],
  ].map(([key, min, max]) => [String(key), Number(min), Number(max)])) {
    if (!Number.isSafeInteger(c[key]) || c[key] < Number(min) || c[key] > Number(max)) throw new Error(`Invalid retry option: ${key}`)
  }
  if (typeof c.jitter !== 'boolean') throw new Error('Invalid retry option: jitter')
  if (!Array.isArray(c.allowedOrigins) || c.allowedOrigins.length > 64) throw new Error('Invalid allowedOrigins')
  c.allowedOrigins = [...new Set(c.allowedOrigins.map(/** @param {string} value */ value => {
    const u = new URL(value)
    if (u.origin !== value || u.username || u.password ||
      (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname)))) {
      throw new Error('allowedOrigins requires HTTPS origins or HTTP loopback origins')
    }
    return u.origin
  }))]
  return Object.freeze(c)
}
