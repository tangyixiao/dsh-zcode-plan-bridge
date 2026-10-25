import fs from 'node:fs'
import path from 'node:path'
import { createRetryFetch, sleep } from './retry-fetch.mjs'
import { isModelRequest } from './policy.mjs'
import { loadConfig, writeRuntime } from './state.mjs'
import { VERSION } from './config.mjs'
import { markCommittedResponse, installIdleGuard } from './model-idle.mjs'

const key = Symbol.for('zcode-community-retry.native.v1')

export function pluginEnabled(settingsFile, pluginId) {
  if (!settingsFile || !fs.existsSync(settingsFile)) return true
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  return settings.plugins?.enabled !== false && settings.plugins?.enabledPlugins?.[pluginId] !== false
}

export function nativeConfig(dataDir, settingsFile, pluginId) {
  const config = { ...loadConfig(dataDir) }
  if (settingsFile && fs.existsSync(settingsFile)) {
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
    const seconds = settings.plugins?.options?.[pluginId]?.intervalSeconds
    if (seconds !== undefined) {
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400) throw new Error('Retry interval must be 0..86400 seconds')
      config.intervalMs = Math.round(seconds * 1000)
    }
  }
  if (config.mode !== 'unlimited') throw new Error('Native ZCode plugin requires unlimited mode; bounded mode is available through the explicit CLI/DSH loader')
  return config
}

/** Called inside the verified Desktop Agent, never inside the MCP helper. */
function registered(settingsFile, pluginId, pluginRoot) {
  if (!settingsFile || !pluginRoot) return false
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  if (pluginId.endsWith('@inline')) return settings.plugins?.dirs?.some(dir => path.resolve(dir) === path.resolve(pluginRoot)) === true
  const index = path.join(path.dirname(settingsFile), 'plugins', 'installed_plugins.json')
  const plugins = JSON.parse(fs.readFileSync(index, 'utf8')).plugins
  return plugins?.some(p => p.id === pluginId && path.resolve(p.installPath) === path.resolve(pluginRoot)) === true
}

export function installNativeRetry({ dataDir, pluginId, pluginPid, leaseFile, settingsFile, pluginRoot, transportPrototypes = [], adapterPrototypes = [] }) {
  if (!pluginEnabled(settingsFile, pluginId)) return { active: false, reason: 'plugin_disabled', settingsFile }
  const existing = globalThis[key]
  if (existing?.active && existing.version !== VERSION) existing.uninstall('plugin_updated')
  if (existing?.active) {
    if (existing.pluginId !== pluginId || existing.dataDir !== dataDir) throw new Error('A different retry owner is already active')
    existing.addLease(pluginPid, leaseFile)
    existing.addPrototypes(transportPrototypes)
    existing.addIdleGuards(adapterPrototypes)
    return { active: true, pid: process.pid, version: VERSION, reused: true, settingsFile }
  }
  if (typeof globalThis.fetch !== 'function' || typeof AbortSignal.any !== 'function') throw new Error('Unsupported Agent fetch runtime')
  let lastConfig = nativeConfig(dataDir, settingsFile, pluginId), configFailureAt, settingsAt = Date.now(), registrationAt = Date.now()
  const readConfig = () => {
    try { lastConfig = nativeConfig(dataDir, settingsFile, pluginId); configFailureAt = undefined }
    catch (error) {
      configFailureAt ??= Date.now()
      if (!(error instanceof SyntaxError || error.code) || Date.now() - configFailureAt > 6000) throw error
    }
    return lastConfig
  }
  let registrationObserved = false
  try { registrationObserved = registered(settingsFile, pluginId, pluginRoot) } catch {}
  const original = globalThis.fetch, leases = new Map(), controllers = new Set(), patches = new Map(), transports = new WeakMap(), idleGuards = new Map()
  let latest = { pid: process.pid, version: VERSION, owner: 'zcode-plugin', state: 'loaded', at: Date.now() }
  const persist = () => { try { writeRuntime(dataDir, { ...latest, at: Date.now() }) } catch {} }
  const controller = {
    active: true, pluginId, dataDir, version: VERSION,
    addLease(pid, file) { leases.set(pid, { file, lastSeen: Date.now() }) },
    addPrototypes(prototypes) {
      for (const prototype of prototypes) {
        if (patches.has(prototype)) continue
        const resolver = Object.getOwnPropertyDescriptor(prototype, 'resolveProviderTransport')?.value
        if (typeof resolver !== 'function' || typeof prototype.createFactory !== 'function' || typeof prototype.bindModel !== 'function') throw new Error('Unsupported model transport prototype')
        function resolve(...args) {
          const transport = resolver.apply(this, args)
          if (!controller.active) return transport
          if (typeof transport !== 'function') throw new Error('Unsupported model transport')
          if (!transports.has(transport)) transports.set(transport, manage(transport))
          return transports.get(transport)
        }
        patches.set(prototype, [{ method: 'resolveProviderTransport', original: resolver, wrapped: resolve }])
        prototype.resolveProviderTransport = resolve
      }
    },
    addIdleGuards(prototypes) {
      for (const prototype of prototypes) if (!idleGuards.has(prototype)) {
        idleGuards.set(prototype, installIdleGuard(prototype, resolved => {
          if (!controller.active) return false
          try { return readConfig().allowedOrigins.includes(new URL(resolved.baseURL).origin) } catch { return false }
        }))
      }
    },
    uninstall(reason = 'disabled') {
      if (!controller.active) return
      controller.active = false
      clearInterval(timer)
      if (globalThis.fetch === wrapped) globalThis.fetch = original
      for (const [prototype, records] of patches) for (const patch of records) if (prototype[patch.method] === patch.wrapped) prototype[patch.method] = patch.original
      for (const restore of idleGuards.values()) restore()
      for (const pending of controllers) pending.abort(new DOMException('Community retry disabled', 'AbortError'))
      latest = { ...latest, state: 'disabled', reason }; persist()
    },
  }
  controller.addLease(pluginPid, leaseFile)
  function manage(transport) { return function managed(input, init = {}) {
    if (!controller.active) return transport(input, init)
    let config
    try { config = readConfig() }
    catch { controller.uninstall('invalid_configuration'); return Promise.reject(new Error('Community Retry configuration is invalid; fix the settings or disable the plugin')) }
    if (!isModelRequest(input, init, config)) return transport(input, init)
    const pending = new AbortController(), caller = init.signal ?? (input instanceof Request ? input.signal : undefined)
    controllers.add(pending)
    const fetch = createRetryFetch(transport, config, {
      getIntervalMs: () => readConfig().intervalMs,
      sleep,
      onStatus(state) { if (controller.active) { latest = { ...latest, ...state }; persist() } },
    })
    return fetch(input, { ...init, signal: caller ? AbortSignal.any([caller, pending.signal]) : pending.signal }).then(markCommittedResponse)
      .finally(() => controllers.delete(pending))
  } }
  const wrapped = manage(original.bind(globalThis))
  const timer = setInterval(() => {
    try {
      try {
        if (!pluginEnabled(settingsFile, pluginId)) { controller.uninstall('plugin_disabled'); return }
        settingsAt = Date.now()
      } catch { if (Date.now() - settingsAt > 6000) controller.uninstall('settings_unavailable'); return }
      let registration = false
      try { registration = registered(settingsFile, pluginId, pluginRoot); registrationAt = Date.now() }
      catch {
        if (registrationObserved && Date.now() - registrationAt > 6000) { controller.uninstall('registration_unavailable'); return }
        registration = registrationObserved
      }
      if (registrationObserved && !registration) { controller.uninstall('plugin_uninstalled'); return }
      for (const [pid, leaseState] of leases) {
        let alive = false
        try { process.kill(pid, 0); alive = true } catch {}
        if (!alive) { leases.delete(pid); continue }
        try {
          const lease = JSON.parse(fs.readFileSync(leaseState.file, 'utf8'))
          if (lease.pid === pid && lease.parentPid === process.pid && Number.isFinite(lease.at) && lease.at <= Date.now() + 5000) leaseState.lastSeen = lease.at
        } catch {}
        if (Date.now() - leaseState.lastSeen > 6000) leases.delete(pid)
      }
      // MCP discovery helpers can exit normally while the plugin remains enabled.
      // In an installed/inline plugin, registration and its real enable switch own
      // the runtime lifetime; a helper lease alone must not cancel user work.
      if (!leases.size && !registration) { controller.uninstall('plugin_stopped'); return }
      persist()
    } catch { controller.uninstall('settings_unavailable') }
  }, 1000)
  timer.unref()
  try { controller.addPrototypes(transportPrototypes); controller.addIdleGuards(adapterPrototypes) } catch (error) { controller.uninstall('unsupported_transport'); throw error }
  globalThis[key] = controller
  // A Desktop model execution caches its transport before MCP discovery. Patch
  // that resolver, not just global fetch, so existing sessions are covered too.
  if (!transportPrototypes.length) globalThis.fetch = wrapped
  persist()
  return { active: true, pid: process.pid, version: VERSION, reused: false, settingsFile }
}
