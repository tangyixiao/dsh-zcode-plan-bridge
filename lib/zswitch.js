/** Z·SWITCH CLI protocol adapter. Credential/account persistence remains owned by Z·SWITCH. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const execute = promisify(execFile)
/** @returns {string} */
export function defaultAccountPath() { return path.join(process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh'), 'dsh-zcode-plan-bridge', 'accounts.json') }

/** @param {any} raw */
function identityFields(raw) {
  const value = (/** @type {unknown} */ field) => typeof field === 'string' && field.trim().length > 0 && field.length <= 320 && !/^enc:/iu.test(field) ? field.trim() : ''
  const userId = value(raw?.user_id), email = value(raw?.email).toLowerCase()
  const identityHash = userId || email ? createHash('sha256').update(JSON.stringify(userId ? ['id',userId] : ['email',email])).digest('hex') : ''
  return {userId,email,identityHash}
}

export const accountId = /** @param {unknown} value */ value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/u.test(value)
/** @param {string} code @returns {Error & {code:string}} */
export function accountError(code) { return Object.assign(new Error(code), { code }) }
/** @param {unknown} value @param {number} [max] @returns {string|undefined} */
function text(value, max = 120) { return typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value) ? value : undefined }
/** @param {any} value */
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
/** @param {any} value @returns {any} */
export function projectState(value) {
  if (value?.ok !== true || !Array.isArray(value.accounts) || value.accounts.length > 100) throw accountError('zswitch-invalid-state')
  const seen = new Set()
  const accounts = value.accounts.map(/** @param {any} item */ item => {
    if (!accountId(item?.id) || seen.has(item.id) || text(item.name) === undefined) throw accountError('zswitch-invalid-state')
    seen.add(item.id)
    const summary = { id: item.id, name: item.name, provider: ['zai', 'bigmodel'].includes(item.identity?.provider) ? item.identity.provider : 'unknown',
      expired: item.jwt_expired === true, updatedAt: text(item.updated_at, 80) ?? '' }
    return Object.defineProperty(summary, 'identityHash', { value: identityFields(item.identity).identityHash })
  })
  const activeId = value.active_account_id ?? null
  if (activeId !== null && (!accountId(activeId) || !seen.has(activeId))) throw accountError('zswitch-invalid-state')
  // The digest binds live token generation and library changes without exposing either.
  const revision = createHash('sha256').update(JSON.stringify([activeId, value.live_hash, accounts])).digest('hex')
  return { available: true, revision, activeId, running: value.zcode_running === true, accounts }
}
/** @param {any} value @returns {any} */
export function projectQuota(value) {
  if (value?.ok !== true || (value.items !== undefined && !Array.isArray(value.items))) throw accountError('zswitch-invalid-state')
  const item = (/** @type {any} */ row) => ({ name: text(row?.name), total: number(row?.total), used: number(row?.used), remaining: number(row?.remaining), unit: text(row?.unit, 30), reset: text(row?.period_end ?? row?.reset, 80) })
  return { observedAt: Date.now(), total: number(value.total), used: number(value.used), remaining: number(value.remaining), plan: text(value.plan_tier),
    items: (value.items ?? []).slice(0, 100).map(item) }
}
/** @param {string} [explicit] @returns {string} */
export function locateZSwitch(explicit = '') {
  if (explicit.trim()) return path.isAbsolute(explicit.trim()) ? explicit.trim() : ''
  const name = process.platform === 'win32' ? 'zcode-switch.exe' : 'zcode-switch'
  const candidates = [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'zcode-switch', name),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'zcode-switch', name),
    ...(process.platform === 'win32' ? ['D:/zcode-switch/zcode-switch.exe', 'C:/zcode-switch/zcode-switch.exe'] : ['/usr/local/bin/zcode-switch', '/usr/bin/zcode-switch']),
    ...(process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, name))]
  return candidates.find(file => file && path.isAbsolute(file) && fs.existsSync(file)) || ''
}

export class ZSwitchClient {
  /** @param {{path?:string,run?:Function}} [options] */
  constructor(options = {}) { this.path = locateZSwitch(options.path); this.run = options.run ?? execute }
  /** Reject a manager/plugin root mismatch rather than mutating a different login. @param {string} [dataBaseDir] */
  assertRoot(dataBaseDir = '') {
    const home = process.env.ZCODE_SWITCH_HOME || process.env.USERPROFILE || process.env.HOME || os.homedir()
    let bootstrap
    try { bootstrap = JSON.parse(fs.readFileSync(path.join(home, '.zcode', 'v2', 'setting.json'), 'utf8')).dataBaseDir } catch { /* Default native root. */ }
    const root = [process.env.ZCODE_SWITCH_DATA_ROOT, bootstrap, process.env.ZCODE_DATA_BASE_DIR, home].find(value => typeof value === 'string' && path.isAbsolute(value))
    const expected = path.join(root, '.zcode', 'v2', 'credentials.json')
    const normalize = (/** @type {string} */ value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
    if (normalize(expected) !== normalize(path.join(dataBaseDir.trim() || process.env.ZCODE_DATA_BASE_DIR?.trim() || os.homedir(), '.zcode', 'v2', 'credentials.json'))) throw accountError('zswitch-root-mismatch')
  }
  /** @param {string[]} args @returns {Promise<any>} */
  async invoke(args) {
    if (!this.path) throw accountError('zswitch-unavailable')
    try {
      const { stdout } = await this.run(this.path, ['--cli', ...args], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 45000, maxBuffer: 524288 })
      const value = JSON.parse(stdout)
      if (value?.ok !== true) throw new Error('rejected')
      return value
    } catch { throw accountError('zswitch-unavailable') }
  }
  /** @returns {Promise<any>} */
  async state() { return projectState(await this.invoke(['state'])) }
  /** Resolve only catalog identity metadata for explicit browser authorization. @param {string} id */
  async member(id) {
    if (!accountId(id)) throw accountError('account-not-found')
    const raw = await this.invoke(['state'])
    const member = projectState(raw).accounts.find((/** @type {any} */ row) => row.id === id)
    if (!member) throw accountError('account-not-found')
    const identity = raw.accounts.find((/** @type {any} */ row) => row.id === id).identity
    return {id:member.id, provider:member.provider, ...identityFields(identity)}
  }
  /** @param {string} action @param {{id?:string,name?:string}} params @returns {Promise<any>} */
  async command(action, params = {}) {
    if (!['capture', 'switch', 'rename', 'delete', 'update'].includes(action) || (action !== 'capture' && !accountId(params.id))
      || (['capture', 'rename'].includes(action) && (text(params.name, 80) === undefined || !params.name?.trim() || params.name.startsWith('--')))) throw accountError('zswitch-invalid-action')
    const args = [action, ...(params.id ? ['--id', params.id] : []), ...(params.name ? ['--name', params.name] : []), ...(action === 'switch' ? ['--no-restart', '--hot', 'true'] : [])]
    const value = await this.invoke(args)
    return { ...(accountId(value.id) ? { id: value.id } : {}), switched: value.switched === true, alreadyActive: value.already_active === true,
      ...(value.probe?.kind && ['entitled', 'no_entitlement', 'auth_failed'].includes(value.probe.kind) ? { probe: { kind: value.probe.kind, models: Array.isArray(value.probe.models) ? value.probe.models.filter((/** @type {any} */ id) => text(id, 128)).slice(0, 100) : [] } } : {}) }
  }
  /** @param {string} id @returns {Promise<any>} */
  async quota(id) {
    if (!accountId(id)) throw accountError('zswitch-invalid-action')
    return projectQuota(await this.invoke(['quota', '--id', id]))
  }
}
