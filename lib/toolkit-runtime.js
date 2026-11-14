/** One authority for owner controls, adapter preferences and bounded observations. */
import os from 'node:os'
import path from 'node:path'
import { ToolkitSettingsStore, ObservationLog, accountScope, toolkitError, validateSettingsPatch } from './toolkit-state.js'
import { localStatus, shareableStatus } from './toolkit-diagnostics.js'
import { resolveCommunityRetry } from './community-retry.js'
import { fetchStartPlanStatus } from './start-plan.js'
import { pickCatalogEntry, resolveBuiltinRuntime } from './zcode-runtime.js'

export class ToolkitRuntime {
  /** @param {{adapter:import('./app-server.js').ZcodeAppServerAdapter, options:()=>import('./index.js').ResolvedOptions, store?:ToolkitSettingsStore}} deps */
  constructor({ adapter, options, store }) {
    this.adapter = adapter
    this.baseOptions = options
    this.store = store ?? new ToolkitSettingsStore(defaultSettingsPath())
    this.log = new ObservationLog()
    this.pending = false
    this.disposed = false
    /** @type {{scope:string, value:any}|undefined} */
    this.plan = undefined
    this.adapter.preferences = () => this.preferences()
    this.adapter.observe = (scope, result) => this.log.record(scope, result)
    // Shared authoritative overlay; CLI reads this same store through diagnostics.
    this.options = () => {
      const base = this.baseOptions()
      const settings = this.preferences()
      return { ...base, authorizationPolicy: settings.authorizationPolicy ?? base.authorizationPolicy,
        communityRetry: settings.retry === null ? base.communityRetry : resolveCommunityRetry({ ...base.communityRetry?.config, dataDirectory: base.communityRetry?.dataDirectory, enabled: base.communityRetry?.enabled, ...settings.retry }) }
    }
    this.adapter.options = this.options
    this.adapter.client.options = this.options
    this.adapter.toolkitIdentity = this.adapter.currentToolkitIdentity()
  }

  /** @returns {string} */
  scope() { return accountScope(this.baseOptions()) }
  preferences() { return this.store.read(this.scope()) }

  /** Read never starts a process or performs a network request. @returns {Promise<any>} */
  async state() {
    this.adapter.syncToolkitIdentity()
    const scope = this.scope()
    const options = this.options()
    const settings = this.store.read(scope)
    const status = localStatus(options)
    const available = options.cliModels.length ? options.cliModels : this.adapter.catalog ? await this.adapter.allModels() : []
    const models = available.slice(0, 256).map(model => {
      const entry = pickCatalogEntry(this.adapter.catalog ?? [], model.cliModelId)
      return { id: model.id, name: model.name, contextWindow: model.contextWindow, maxTokens: model.maxTokens, image: model.inputModalities.includes('image'),
        reasoningLevels: entry?.reasoningLevels ?? [], defaultReasoning: settings.reasoning[model.id] ?? entry?.defaultReasoningLevel,
        visible: !settings.hiddenModels.includes(model.id) }
    })
    if (scope !== this.scope()) throw toolkitError('account-changed')
    const retry = options.communityRetry
    return { ...status, scope, settings, models, modelSource: options.cliModels.length ? 'configured' : this.adapter.catalog ? 'cli' : 'not-read',
      runtime: this.adapter.toolkitStatus(), busy: this.adapter.toolkitBusy() || this.pending,
      authorizationPolicy: options.authorizationPolicy,
      retry: { enabled: retry.enabled, mode: retry.config.mode, intervalMs: retry.config.intervalMs, maxRetries: retry.config.maxRetries,
        baseDelayMs: retry.config.baseDelayMs, maxDelayMs: retry.config.maxDelayMs, backoffFactor: retry.config.backoffFactor, jitter: retry.config.jitter, budgetMs: retry.config.budgetMs },
      observations: this.log.read(scope), ...(this.plan?.scope === scope ? { plan: this.plan.value } : {}), diagnostic: shareableStatus(status) }
  }

  /** @param {any} action @returns {Promise<{state:string}>} */
  async action(action) {
    if (this.disposed) throw toolkitError('runtime-disposed')
    if (action.scope !== this.scope()) throw toolkitError('account-changed')
    if (action.revision !== this.preferences().revision) throw toolkitError('stale-state')
    if (this.pending || this.adapter.toolkitBusy()) throw toolkitError('runtime-busy')
    this.pending = true
    const scope = action.scope
    /** @returns {void} */
    const check = () => {
      if (this.disposed) throw toolkitError('runtime-disposed')
      if (scope !== this.scope()) throw toolkitError('account-changed')
      if (action.revision !== this.preferences().revision) throw toolkitError('stale-state')
    }
    try {
      if (action.action === 'settings') {
        validateSettingsPatch(action.patch)
        const models = await this.adapter.allModels()
        check()
        if (this.adapter.toolkitBusy()) throw toolkitError('runtime-busy')
        const next = { ...this.preferences(), ...action.patch }
        if (models.length && models.every(model => next.hiddenModels.includes(model.id))) throw toolkitError('no-selectable-models')
        for (const [id, effort] of Object.entries(next.reasoning)) {
          const model = models.find(model => model.id === id)
          const entry = pickCatalogEntry(this.adapter.catalog ?? [], model?.cliModelId ?? id)
          if (!model || !entry?.reasoningLevels.includes(/** @type {string} */ (effort))) throw toolkitError('unsupported-reasoning')
        }
        this.store.update(scope, action.revision, action.patch)
        // Retry changes take effect on a new idle child before another request.
        this.adapter.syncToolkitIdentity()
      } else if (action.action === 'refresh-catalog') {
        await this.adapter.refreshCatalog(); check()
      } else if (action.action === 'clear-cache') {
        await this.adapter.clearIdleCaches(); check()
      } else if (action.action === 'refresh-plan') {
        const options = this.options()
        if (options.accountMode !== 'start-plan') throw toolkitError('unsupported-channel')
        this.adapter.toolkitManaging = true
        try {
          const value = await fetchStartPlanStatus(resolveBuiltinRuntime(options.zcodeDataBaseDir, options.zcodeCliPath), options.zcodeDataBaseDir)
          check(); this.plan = { scope, value }
        } finally { this.adapter.toolkitManaging = false }
      } else throw toolkitError('invalid-action')
      return { state: 'applied' }
    } finally { this.pending = false }
  }

  dispose() { this.disposed = true; this.plan = undefined; this.log.clear(); this.adapter.observe = undefined }
}

/** A per-DSH-home store; account and channel keys remain isolated inside it. */
export function defaultSettingsPath() { return path.join(process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh'), 'dsh-zcode-plan-bridge', 'toolkit.json') }
