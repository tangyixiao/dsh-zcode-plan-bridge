/** Request policy only: Z·SWITCH remains the account library; DSH owns its execution scope. */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { ZSwitchClient, accountError, accountId } from './zswitch.js'
import { ZSwitchProfiles } from './zswitch-profiles.js'
import { accountScope } from './toolkit-state.js'

/** @param {any} value @returns {string} */
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
/** @returns {string} */
export function defaultAccountPath() { return path.join(process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh'), 'dsh-zcode-plan-bridge', 'accounts.json') }
const MAX = 65536

export class ZSwitchAccounts {
  /** @param {{client?:any,file?:string,adapter:any,options:()=>any,generation?:()=>string,profiles?:any}} deps */
  constructor(deps) {
    this.baseOptions = deps.options; this.adapter = deps.adapter
    this.client = deps.client ?? new ZSwitchClient({ path: deps.options().zSwitchPath })
    this.file = deps.file ?? defaultAccountPath()
    this.profiles = deps.profiles ?? new ZSwitchProfiles({ root: path.join(path.dirname(this.file), 'native-profiles') })
    this.generation = deps.generation ?? (() => accountScope(this.effectiveOptions(this.baseOptions())))
    this.managing = false; this.disposed = false
    /** @type {any} */ this.profileOptions = undefined
    /** @type {Record<string,any>} */ this.quotas = {}
  }
  /** @returns {any} */
  document() {
    try {
      const fd = fs.openSync(this.file, 'r'); let bytes
      try { if (fs.fstatSync(fd).size > MAX) throw new Error('size'); bytes = Buffer.alloc(MAX + 1); bytes = bytes.subarray(0, fs.readSync(fd, bytes)) } finally { fs.closeSync(fd) }
      if (bytes.length > MAX) throw new Error('size')
      const d = JSON.parse(bytes.toString('utf8'))
      if (d.version !== 1 || !/^[a-f0-9-]{36}$/u.test(d.revision) || typeof d.enabled !== 'boolean' || !['independent','shared'].includes(d.mode)
        || !Array.isArray(d.order) || d.order.length > 100 || !d.order.every(accountId) || new Set(d.order).size !== d.order.length
        || !Array.isArray(d.exhausted) || d.exhausted.length > 100 || !d.exhausted.every(accountId)
        || !Array.isArray(d.blocked) || d.blocked.length > 32 || !d.blocked.every((/** @type {any} */ id) => /^[a-f0-9]{64}$/u.test(id))
        || !Array.isArray(d.history) || d.history.length > 20 || (d.selectedId !== null && !accountId(d.selectedId))
        || !d.history.every((/** @type {any} */ event) => event && accountId(event.from) && accountId(event.to) && typeof event.at === 'number' && Number.isFinite(event.at) && event.at > 0 && event.reason === 'quota' && Object.keys(event).every(key => ['from','to','at','reason'].includes(key)))
        || (d.primaryId !== null && !accountId(d.primaryId))
        || (d.pending !== null && (!accountId(d.pending.from) || !/^[a-f0-9]{64}$/u.test(d.pending.source) || typeof d.pending.generation !== 'string'))) throw new Error('document')
      return d
    } catch (error) {
      if (/** @type {any} */ (error)?.code === 'ENOENT') return { version: 1, revision: 'initial', enabled: false, mode: this.baseOptions().zSwitchAccountMode === 'shared' ? 'shared' : 'independent',
        order: [], selectedId: null, primaryId: null, exhausted: [], pending: null, blocked: [], history: [] }
      throw accountError('invalid-storage')
    }
  }
  /** @param {string} revision @param {(d:any)=>void} mutate @returns {any} */
  update(revision, mutate) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    let lock
    try { lock = fs.openSync(this.file + '.lock', 'wx', 0o600) } catch { throw accountError('storage-busy') }
    const temp = `${this.file}.${randomUUID()}.tmp`
    try {
      const d = this.document()
      if (d.revision !== revision) throw accountError('stale-state')
      mutate(d); d.revision = randomUUID()
      const body = JSON.stringify(d)
      if (Buffer.byteLength(body) > MAX) throw accountError('storage-full')
      fs.writeFileSync(temp, body, { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, this.file)
      return d
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); fs.closeSync(lock); fs.unlinkSync(this.file + '.lock') }
  }
  enabled() { return this.document().enabled }
  /** Overlay only native account bindings; preserve live model/retry/tool configuration. @param {any} base @returns {any} */
  effectiveOptions(base) {
    const d = this.document()
    return d.mode === 'independent' && d.selectedId && this.profileOptions?.managedAccount.id === d.selectedId ? { ...base, ...this.profileOptions } : base
  }
  /** Restore the selected DSH profile before status, catalog or plan reads. No native process is started. */
  async hydrate() {
    const d = this.document()
    if (d.mode !== 'independent' || !d.selectedId || this.profileOptions?.managedAccount.id === d.selectedId) return
    if (this.disposed) throw accountError('runtime-disposed')
    if (this.managing || this.adapter.toolkitBusy()) throw accountError('runtime-busy')
    this.managing = true
    try { await this.choose(d.selectedId, d); this.adapter.syncToolkitIdentity() }
    finally { this.managing = false }
  }
  /** @param {any} source @param {any} d @returns {string} */
  sourceStamp(source, d) { return d.mode === 'shared' ? source.revision : digest(source.accounts) }
  /** @param {any} source @param {any} d @returns {string} */
  revision(source, d) { return digest([d.revision, source.revision]) }
  /** Read summaries only, never rotates or runs generation. @returns {Promise<any>} */
  async state() {
    const source = await this.client.state(), d = this.document()
    const activeId = d.mode === 'independent' && d.selectedId ? d.selectedId : source.activeId
    return { ...source, revision: this.revision(source, d), mode: d.mode, enabled: d.enabled, activeId, desktopId: source.activeId,
      primaryId: d.primaryId ?? activeId, following: d.selectedId === null, order: d.order, exhausted: d.exhausted,
      pending: d.pending ? { from: d.pending.from, reason: 'quota' } : null, history: d.history,
      accounts: source.accounts.map((/** @type {any} */ item) => ({ ...item, ...(this.quotas[item.id] ? { quota: this.quotas[item.id] } : {}) })) }
  }
  /** @param {string} id @param {any} d @returns {Promise<void>} */
  async choose(id, d) {
    if (d.mode === 'independent') {
      const snapshot = await this.client.snapshot(id)
      const resolved = this.profiles.activate(snapshot, this.baseOptions())
      this.profileOptions = { zcodeCliPath: resolved.zcodeCliPath, zcodeDataBaseDir: resolved.zcodeDataBaseDir, managedAccount: resolved.managedAccount }
    } else {
      this.client.assertRoot(this.baseOptions().zcodeDataBaseDir)
      const result = await this.client.command('switch', { id })
      const after = await this.client.state()
      if (after.activeId !== id || result.probe?.kind === 'auth_failed') throw accountError('account-switch-unverified')
      this.profileOptions = undefined
    }
  }
  /** @param {any} action @returns {Promise<void>} */
  async action(action) {
    if (this.disposed) throw accountError('runtime-disposed')
    if (this.managing || this.adapter.toolkitBusy()) throw accountError('runtime-busy')
    this.managing = true
    try {
      const source = await this.client.state(), d = this.document()
      if (action.revision !== this.revision(source, d)) throw accountError('stale-state')
      if (this.adapter.toolkitBusy()) throw accountError('runtime-busy')
      const has = (/** @type {string} */ id) => source.accounts.some((/** @type {any} */ item) => item.id === id)
      if (action.id && (!accountId(action.id) || !has(action.id))) throw accountError('account-not-found')
      if (action.operation === 'policy') {
        if (typeof action.enabled !== 'boolean' || !Array.isArray(action.order) || action.order.length > 100 || !action.order.every(has)
          || new Set(action.order).size !== action.order.length || !['independent', 'shared'].includes(action.mode ?? d.mode)) throw accountError('zswitch-invalid-action')
        if (action.enabled && action.order.length === 0) throw accountError('account-no-members')
        const targetMode = action.mode ?? d.mode
        const targetSelected = targetMode === d.mode ? d.selectedId : null
        if (action.enabled && !accountId(targetMode === 'independent' ? targetSelected ?? source.activeId : source.activeId)) throw accountError('account-current-unknown')
        this.update(d.revision, next => { next.enabled = action.enabled; next.order = action.order; next.mode = action.mode ?? d.mode;
          next.primaryId = d.mode === 'independent' ? d.selectedId ?? source.activeId : source.activeId; next.pending = null; next.blocked = [];
          if (next.mode !== d.mode) { next.selectedId = null; next.primaryId = source.activeId } })
        if ((action.mode ?? d.mode) !== d.mode) { this.profileOptions = undefined; this.adapter.syncToolkitIdentity() }
      } else if (action.operation === 'select') {
        await this.choose(action.id, d)
        this.update(d.revision, next => { next.selectedId = action.id; next.primaryId = action.id; next.pending = null; next.blocked = [] })
        this.adapter.syncToolkitIdentity()
      } else if (action.operation === 'follow') {
        this.update(d.revision, next => { next.selectedId = null; next.primaryId = null; next.pending = null; next.blocked = []; next.enabled = false })
        this.profileOptions = undefined; this.adapter.syncToolkitIdentity()
      } else if (action.operation === 'reset') {
        this.update(d.revision, next => { next.exhausted = next.exhausted.filter((/** @type {string} */ id) => id !== action.id); next.pending = null; next.blocked = [] })
      } else if (action.operation === 'quota') {
        this.quotas[action.id] = await this.client.quota(action.id)
      } else if (['capture','rename','update','delete'].includes(action.operation)) {
        if (action.operation === 'delete' && [source.activeId, d.selectedId].includes(action.id)) throw accountError('account-selected')
        this.client.assertRoot(this.baseOptions().zcodeDataBaseDir)
        await this.client.command(action.operation, { id: action.id, name: action.name })
        this.update(d.revision, next => { next.pending = null; next.blocked = [];
          if (action.operation === 'delete') { next.order = next.order.filter((/** @type {string} */ id) => id !== action.id); next.exhausted = next.exhausted.filter((/** @type {string} */ id) => id !== action.id); if (!next.order.length) next.enabled = false } })
      } else throw accountError('zswitch-invalid-action')
    } finally {
      // A manager error may follow a partial shared switch. Always invalidate old native scope.
      try { if (!this.adapter.toolkitBusy()) this.adapter.syncToolkitIdentity() }
      finally { this.managing = false }
    }
  }
  /** Admit a new request or the continuation of the exact quota failure. @param {any} request @param {string} [continuationRevision] @returns {Promise<any>} */
  async prepare(request, continuationRevision) {
    if (this.disposed) throw accountError('runtime-disposed')
    if (request.signal?.aborted) throw accountError('ABORTED')
    if (request.purpose === 'session-title') return undefined
    const first = this.document()
    if (continuationRevision === undefined && !first.enabled && !first.selectedId) return undefined
    if (this.managing) throw accountError('runtime-busy')
    this.managing = true
    try {
      let d = this.document()
      if (continuationRevision !== undefined && (!d.enabled || d.mode !== 'independent' || !d.pending || d.revision !== continuationRevision)) {
        throw accountError('stale-state')
      }
      const input = digest(continuationRevision === undefined
        ? [request.sessionId, request.model, request.system, request.messages]
        : [request.sessionId, request.model, request.system, request.messages, continuationRevision])
      if (d.enabled && d.blocked.includes(input)) throw accountError('account-request-replay-blocked')
      const source = await this.client.state()
      let activeId = d.mode === 'independent' && d.selectedId ? d.selectedId : source.activeId
      if (d.enabled && !accountId(activeId)) throw accountError('account-current-unknown')
      if (continuationRevision !== undefined && d.pending?.from !== activeId) throw accountError('stale-state')
      // Restore an already selected private profile before comparing a persisted
      // generation. Comparing against Desktop's scope here would lose rotation on restart.
      if (d.mode === 'independent' && d.selectedId && this.profileOptions?.managedAccount.id !== d.selectedId) {
        if (this.adapter.toolkitBusy()) throw accountError('runtime-busy')
        await this.choose(d.selectedId, d); this.adapter.syncToolkitIdentity()
      }
      if (d.pending && (d.pending.source !== this.sourceStamp(source, d) || d.pending.generation !== this.generation())) {
        if (continuationRevision !== undefined) throw accountError('stale-state')
        d = this.update(d.revision, next => { next.pending = null; next.primaryId = activeId })
      }
      if (d.enabled && d.pending) {
        if (this.adapter.toolkitBusy()) throw accountError('runtime-busy')
        const candidate = d.order.find((/** @type {string} */ id) => !d.exhausted.includes(id) && source.accounts.some((/** @type {any} */ item) => item.id === id && !item.expired))
        if (!candidate) throw accountError('account-pool-exhausted')
        if (request.signal?.aborted) throw accountError('ABORTED')
        await this.choose(candidate, d)
        d = this.update(d.revision, next => { next.selectedId = candidate; next.primaryId ??= activeId; next.pending = null;
          next.history = [...next.history, { from: activeId, to: candidate, at: Date.now(), reason: 'quota' }].slice(-20) })
        activeId = candidate
        this.adapter.syncToolkitIdentity()
      }
      if (request.signal?.aborted) throw accountError('ABORTED')
      if (d.enabled && d.exhausted.includes(activeId)) throw accountError('account-pool-exhausted')
      if (d.selectedId) await this.adapter.validateAccountModel(request.model)
      if (!d.enabled) return undefined
      const after = await this.client.state()
      return { id: activeId, generation: this.generation(), source: this.sourceStamp(after, d), policy: d.revision, input }
    } finally { this.managing = false }
  }
  /** Record only authoritative native quota exhaustion; never switches or resends. @param {any} snapshot @param {any} evidence */
  async failed(snapshot, evidence) {
    if (!snapshot || !accountId(snapshot.id) || this.disposed || evidence.cancelled || evidence.contextExceeded) return
    const code = String(evidence.providerErrorCode)
    const startPlanQuota = code === '1005' && evidence.providerId === 'account:zai-start-plan'
      && typeof evidence.providerMessage === 'string' && /^exceed quota limit$/iu.test(evidence.providerMessage.trim())
    if (code !== '1113' && !startPlanQuota) return
    if (typeof evidence.providerId !== 'string' || !/^account:(?:zai|bigmodel)-(?:start-plan|individual-coding-plan|highspeed-card)$/u.test(evidence.providerId)) return
    if (this.baseOptions().accountMode === 'start-plan' && evidence.providerId !== 'account:zai-start-plan') return
    const d = this.document()
    if (!d.enabled || d.revision !== snapshot.policy || snapshot.generation !== this.generation()) return
    const source = await this.client.state()
    if (this.sourceStamp(source, d) !== snapshot.source) return
    const updated = this.update(d.revision, next => {
      if (!next.exhausted.includes(snapshot.id)) next.exhausted.push(snapshot.id)
      next.primaryId ??= snapshot.id
      next.blocked = [...new Set([...next.blocked, snapshot.input])].slice(-32)
      next.pending = { from: snapshot.id, generation: snapshot.generation, source: snapshot.source }
    })
    return updated.mode === 'independent' ? updated.revision : undefined
  }
  dispose() { this.disposed = true; this.profileOptions = undefined; this.quotas = {} }
}
