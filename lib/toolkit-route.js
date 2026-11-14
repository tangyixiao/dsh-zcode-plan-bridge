/** Host-authenticated, same-origin and revision-bound toolkit route. */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { validateSettingsPatch } from './toolkit-state.js'

export const TOOLKIT_PATH = '/plugins/dsh-zcode-plan-bridge/toolkit'
/** @param {import('node:http').ServerResponse} res @param {number} status @param {any} value */
function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(body)
}
/** @param {any} value @returns {any|undefined} */
export function parseToolkitAction(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const { action, scope, revision } = value
  if (!['settings', 'refresh-catalog', 'clear-cache', 'refresh-plan'].includes(action) || typeof scope !== 'string' || !/^[a-f0-9]{64}$/u.test(scope)
    || typeof revision !== 'string' || !/^(initial|[a-f0-9-]{36})$/u.test(revision)) return undefined
  const keys = ['action', 'scope', 'revision', ...(action === 'settings' ? ['patch'] : [])]
  if (Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) return undefined
  if (action === 'settings') { try { validateSettingsPatch(value.patch) } catch { return undefined } }
  return value
}

/** @param {any} ctx @param {{state:()=>Promise<any>,action:(action:any)=>Promise<any>}} runtime @param {string} key */
export function toolkitHandler(ctx, runtime, key) {
  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    let admission
    try { admission = ctx.get('connection')?.admit(req) } catch { /* No admission, no access. */ }
    if (!admission || 'rejection' in admission) { json(res, admission?.rejection === 403 ? 403 : 401, { error: 'unauthorized' }); return }
    if (admission.peer?.principal?.kind !== 'owner') { json(res, 403, { error: 'forbidden' }); return }
    const host = req.headers.host
    const origin = req.headers.origin
    let trusted = typeof host === 'string' && req.headers['sec-fetch-site'] !== 'cross-site'
    if (origin !== undefined) {
      try {
        const parsed = new URL(origin)
        const protocol = /** @type {any} */ (req.socket).encrypted ? 'https:' : 'http:'
        trusted &&= parsed.origin === `${protocol}//${host}`
      } catch { trusted = false }
    }
    // Desktop's authenticated forwarding removes Origin. Owner admission plus the
    // per-process custom key still applies; any supplied Origin must match exactly.
    if (!trusted) { json(res, 403, { error: 'invalid-origin' }); return }
    if (req.method === 'GET') {
      try { json(res, 200, { ...await runtime.state(), key }) } catch { json(res, 503, { error: 'state-unavailable' }) }
      return
    }
    if (req.method !== 'POST') { json(res, 405, { error: 'method-not-allowed' }); return }
    const provided = req.headers['x-zcode-toolkit-key']
    if (typeof provided !== 'string' || Buffer.byteLength(provided) !== Buffer.byteLength(key) || !timingSafeEqual(Buffer.from(provided), Buffer.from(key))) { json(res, 403, { error: 'invalid-control-key' }); return }
    if (!/^application\/json(?:;|$)/iu.test(req.headers['content-type'] ?? '')) { json(res, 415, { error: 'json-required' }); return }
    if (Number(req.headers['content-length']) > 16384) { json(res, 413, { error: 'body-too-large' }); return }
    /** @type {Buffer[]} */ const buffers = []
    let total = 0
    req.setTimeout(10000, () => req.destroy())
    try {
      for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        total += buffer.length
        if (total > 16384) { json(res, 413, { error: 'body-too-large' }); return }
        buffers.push(buffer)
      }
    } catch { if (!res.destroyed) json(res, 400, { error: 'incomplete-body' }); return }
    finally { req.setTimeout(0) }
    let action
    try { action = parseToolkitAction(JSON.parse(Buffer.concat(buffers).toString('utf8'))) } catch { /* Closed parsing failure. */ }
    if (!action) { json(res, 400, { error: 'invalid-action' }); return }
    try { json(res, 200, await runtime.action(action)) }
    catch (error) {
      const code = /** @type {any} */ (error)?.code
      const allowed = ['account-changed', 'stale-state', 'runtime-busy', 'unsupported-channel', 'unsupported-reasoning', 'no-selectable-models', 'invalid-settings', 'invalid-storage', 'storage-busy', 'storage-full', 'runtime-disposed']
      json(res, ['account-changed', 'stale-state', 'runtime-busy'].includes(code) ? 409 : 400, { error: allowed.includes(code) ? code : 'action-failed' })
    }
  }
}

/** Missing services leave schema/CLI/provider use intact. @param {any} ctx @param {import('./toolkit-runtime.js').ToolkitRuntime} runtime */
export function registerToolkitRoute(ctx, runtime) {
  const key = randomBytes(32).toString('hex')
  ctx.inject(['webServer', 'connection'], (/** @type {any} */ scope) => {
    scope.effect(() => scope.webServer.register({ kind: 'exact', path: TOOLKIT_PATH, handler: toolkitHandler(scope, runtime, key) }), 'zcode: authenticated toolkit')
  })
}
