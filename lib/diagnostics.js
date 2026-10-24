/**
 * Diagnostics for the ZCode bridge: environment checks and protocol probes that need
 * no running DSH host.
 *
 * These started life as ten throwaway scripts (`probe-app-server`, `probe-full-flow`,
 * `probe-plan-provider`, `probe-setmodel`, ...) that each hard-coded one developer's
 * install path and had to be edited to ask a different question. They are consolidated
 * here into subcommands behind one entry point (`dsh-zcode-plan-bridge <command>`),
 * with shared JSON-RPC plumbing and read-only-by-default output.
 *
 * Every command except `turn` and `image` is offline: it only reads local files. Those
 * two spawn the real `zcode app-server`, so they consume Start Plan quota -- which is
 * the point, since they are how you verify the channel really routes there.
 *
 * Usage:
 *   node bin/dsh-zcode-plan-bridge.js doctor
 *   node bin/dsh-zcode-plan-bridge.js models
 *   node bin/dsh-zcode-plan-bridge.js protocol
 *   node bin/dsh-zcode-plan-bridge.js turn [prompt]
 *   node bin/dsh-zcode-plan-bridge.js image <file>
 *
 * @module lib/diagnostics
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'

import { CREDENTIAL_ERROR_CODES, credentialsPath, readZaiPlanAuth } from './credentials.js'
import {
  DEFAULT_REASONING_LEVEL,
  collapseCatalog,
  computeBuiltinRevision,
  locateZcodeCli,
  pickCatalogEntry,
  readBuiltinInventory,
  readModelCatalog,
  resolveBuiltinRuntime,
} from './zcode-runtime.js'

/**
 * @typedef {object} DiagnosticIo
 * @property {(line: string) => void} info Normal progress line.
 * @property {(line: string) => void} warn Warning line (something to fix).
 * @property {(line: string) => void} fail Failure line (something is broken).
 * @property {(line: string) => void} detail Indented detail line.
 * @property {(summary: DiagnosticSummary) => void} report Emit the machine-readable summary.
 */

/**
 * What a diagnostic run found.
 *
 * @typedef {object} DiagnosticSummary
 * @property {string} command Subcommand that ran.
 * @property {boolean} ok Whether everything required was present.
 * @property {Record<string, unknown>} facts Collected values.
 */

/**
 * Options every subcommand accepts. `allowTools` is the important one: probes spawn a
 * real app-server agent under this user's account, so tool permission requests are
 * denied unless the caller opted in with `--allow-tools`.
 *
 * @typedef {object} DiagnosticOptions
 * @property {string} [zcodeCliPath] Path to zcode.cjs ('' = auto-detect).
 * @property {string} [zcodeDataBaseDir] ZCode data root ('' = user home).
 * @property {string} [model] Model id requested by the `turn` command.
 * @property {boolean} [allowTools] Auto-approve tool permission requests.
 */

/**
 * Default console sink.
 *
 * Every severity writes to stdout, not stderr. A diagnostic report is one ordered
 * narrative -- a step heading, then that step's findings -- and splitting it across two
 * streams destroys the order as soon as output is piped or captured (observed: a
 * "not found" line surfacing under the *next* step's heading). The exit code, plus the
 * `ok` field of the `--json` summary, carry the machine-readable verdict instead.
 *
 * @type {DiagnosticIo}
 */
export const consoleIo = {
  info: (line) => console.log(line),
  warn: (line) => console.log(line),
  fail: (line) => console.log(line),
  detail: (line) => console.log(`  ${line}`),
  report: () => {},
}

/**
 * Read the plugin's own package metadata (name/version) without importing the plugin,
 * so `doctor` stays usable when the plugin cannot load against the host.
 *
 * @returns {{ name: string, version: string }} Package identity, or placeholders.
 */
export function readOwnPackage() {
  try {
    const file = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'package.json')
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { name: String(raw.name ?? 'dsh-zcode-plan-bridge'), version: String(raw.version ?? '0.0.0') }
  } catch {
    return { name: 'dsh-zcode-plan-bridge', version: '0.0.0' }
  }
}

/**
 * `doctor`: check every local precondition for the Start Plan channel, in the order the
 * bridge needs them at runtime. Each failure names the option that fixes it.
 *
 * @param {DiagnosticIo} io Output sink.
 * @param {DiagnosticOptions} [options] Configuration overrides.
 * @returns {Promise<DiagnosticSummary>} Collected facts.
 */
export async function doctor(io, options = {}) {
  /** @type {Record<string, unknown>} */
  const facts = {}
  let ok = true
  const pkg = readOwnPackage()
  io.info(`${pkg.name} ${pkg.version} — local diagnostics`)
  io.info('')

  // 1. Node runtime.
  io.info('1. Node runtime')
  io.detail(`node ${process.version} (${process.platform}/${process.arch}), execPath ${process.execPath}`)
  const major = Number(process.versions.node.split('.')[0])
  if (major < 22) {
    io.fail(`   Node ${process.version} is too old for the harness runtime (needs >= 22)`)
    ok = false
  }
  facts.node = process.version

  // 2. The bundled ZCode CLI.
  io.info('2. ZCode CLI (zcode.cjs)')
  const cliPath = locateZcodeCli(options.zcodeCliPath)
  if (cliPath === '') {
    io.fail('   not found: install the ZCode desktop client, or set the zcodeCliPath option / ZCODE_CLI_PATH')
    ok = false
  } else if (!fs.existsSync(cliPath)) {
    io.fail(`   configured path does not exist: ${cliPath}`)
    ok = false
  } else {
    io.detail(`found ${cliPath}`)
  }
  facts.zcodeCliPath = cliPath

  // 3. The builtin runtime the CLI resolves (informational: nothing is injected).
  io.info('3. ZCode builtin runtime (zcode-builtin.json)')
  const builtin = resolveBuiltinRuntime(options.zcodeDataBaseDir, cliPath)
  if (builtin === undefined) {
    io.fail('   not found: launch the ZCode client once and sign in, or let the CLI use its bundled release')
    ok = false
  } else {
    io.detail(`version ${builtin.version} (${builtin.source})`)
    io.detail(`file    ${builtin.activeFilePath}`)
    try {
      const inventory = readBuiltinInventory(builtin.activeFilePath)
      io.detail(`registry revision ${String(inventory.revision)}`)
      io.detail(`providers: ${inventory.providers.map((provider) => provider.id).join(', ') || '(none)'}`)
      io.detail(`configSource revision = ${computeBuiltinRevision(builtin.activeFilePath)}`)
      facts.builtin = {
        version: builtin.version,
        source: builtin.source,
        revision: inventory.revision,
        providers: inventory.providers.map((provider) => provider.id),
      }
    } catch (/** @type {any} */ error) {
      io.fail(`   cannot read the builtin file: ${error?.message ?? error}`)
      ok = false
    }
  }

  // 4. Shared credentials: the token that actually signs each request.
  io.info('4. ZCode credentials')
  try {
    const file = credentialsPath(options.zcodeDataBaseDir)
    io.detail(`file ${file}`)
    const auth = readZaiPlanAuth(options.zcodeDataBaseDir)
    if (auth.planToken === '') {
      io.fail('   no Start Plan token: sign in with the ZCode client')
      ok = false
    } else {
      // Never print the token itself: show only its length and a coarse shape check.
      io.detail(`zcodejwttoken ${auth.planToken.length} chars${auth.planToken.startsWith('eyJ') ? ' (JWT)' : ''}`)
      io.detail(`activeProvider ${auth.activeProvider ?? '(unset)'}`)
      if (auth.accessToken !== undefined) io.detail('oauth:zai:access_token present (expired; not used for signing)')
      facts.credentials = { planTokenLength: auth.planToken.length, activeProvider: auth.activeProvider ?? null }
    }
  } catch (/** @type {any} */ error) {
    const code = String(error?.code ?? '')
    io.fail(`   ${error?.message ?? error}`)
    if (/** @type {readonly string[]} */ (CREDENTIAL_ERROR_CODES).includes(code)) io.detail(`error code: ${code}`)
    ok = false
    facts.credentials = { error: code }
  }

  // 5. What DSH will be offered. The catalogue comes from the CLI itself, so this step
  //    is only meaningful when the CLI is present; it runs a throwaway session and closes
  //    it, which costs nothing (no turn is sent).
  io.info('5. Models the CLI reports to DSH')
  if (cliPath === '') {
    io.warn('   skipped: no CLI to ask')
  } else {
    const catalog = await probeCatalog(io, cliPath, options.allowTools === true)
    if (catalog.length === 0) {
      io.fail('   the CLI reported no models')
      ok = false
    } else {
      for (const entry of collapseCatalog(catalog)) {
        io.detail(`${entry.providerId} / ${entry.modelId} — ctx ${String(entry.contextWindow ?? '?')}, max out ${String(entry.maxOutputTokens ?? '?')}${entry.supportsImage ? ', image' : ''}`)
      }
      facts.catalog = collapseCatalog(catalog).map((entry) => ({
        providerId: entry.providerId,
        modelId: entry.modelId,
        contextWindow: entry.contextWindow ?? null,
        maxOutputTokens: entry.maxOutputTokens ?? null,
        reasoningLevels: entry.reasoningLevels,
      }))
    }
  }
  io.info('')
  if (ok) io.info('All local preconditions satisfied. `turn` verifies the channel end to end (consumes quota).')
  else io.warn('Some preconditions failed; fix the failures above before trying `turn`.')
  const summary = { command: 'doctor', ok, facts }
  io.report(summary)
  return summary
}

/**
 * Ask a throwaway app-server session for its model catalogue, then close the session.
 *
 * `listModels` in the bridge does the same thing, so this doubles as a check that the
 * catalogue path works at all. No turn is sent, so no quota is spent.
 *
 * @param {DiagnosticIo} io Output sink (warnings only).
 * @param {string} cliPath Path to zcode.cjs.
 * @param {boolean} [allowTools] Auto-approve tool permission requests (opt-in).
 * @returns {Promise<import('./zcode-runtime.js').CatalogEntry[]>} Catalogue entries (empty on failure).
 */
async function probeCatalog(io, cliPath, allowTools = false) {
  const server = new ProbeServer(cliPath, { allowTools })
  try {
    const created = await server.request('session/create', {
      workspace: { workspacePath: os.homedir(), workspaceKey: 'dsh-zcode-plan-bridge-diagnostics' },
    })
    const catalog = readModelCatalog(created)
    const sessionId = created?.session?.sessionId
    if (typeof sessionId === 'string' && sessionId !== '') {
      // Close it: the probe must not leave a ghost session in the client's GUI session list.
      try {
        await server.request('session/close', { sessionId }, 15_000)
      } catch {
        /* Closing is best-effort. */
      }
    }
    return catalog
  } catch (/** @type {any} */ error) {
    io.warn(`   could not read the catalogue: ${error?.message ?? error}`)
    return []
  } finally {
    server.kill()
  }
}

/**
 * `models`: print the model catalogue the CLI reports, i.e. exactly what DSH will offer.
 *
 * @param {DiagnosticIo} io Output sink.
 * @param {DiagnosticOptions} [options] Configuration overrides.
 * @returns {Promise<DiagnosticSummary>} Collected facts.
 */
export async function models(io, options = {}) {
  const cliPath = locateZcodeCli(options.zcodeCliPath)
  if (cliPath === '') {
    io.fail('no ZCode CLI found (set zcodeCliPath or ZCODE_CLI_PATH)')
    const failed = { command: 'models', ok: false, facts: {} }
    io.report(failed)
    return failed
  }
  const catalog = await probeCatalog(io, cliPath, options.allowTools === true)
  if (catalog.length === 0) {
    io.fail('the CLI reported no models (is the ZCode client signed in?)')
    const failed = { command: 'models', ok: false, facts: { zcodeCliPath: cliPath } }
    io.report(failed)
    return failed
  }
  io.info(`models reported by ${cliPath}`)
  io.info('')
  const collapsed = collapseCatalog(catalog)
  for (const entry of collapsed) {
    io.info(`${entry.providerId} / ${entry.modelId}`)
    io.detail(`label     ${entry.label}${entry.providerLabel === entry.label ? '' : ` (${entry.providerLabel})`}`)
    io.detail(`context   ${String(entry.contextWindow ?? 'unreported')} tokens`)
    io.detail(`max out   ${String(entry.maxOutputTokens ?? 'unreported')} tokens`)
    io.detail(`reasoning ${entry.reasoningLevels.length === 0 ? 'unreported' : entry.reasoningLevels.join(' / ')}${entry.defaultReasoningLevel === undefined ? '' : ` (default ${entry.defaultReasoningLevel})`}`)
    io.detail(`image     ${entry.supportsImage ? 'supported' : 'not supported'}`)
  }
  io.info('')
  io.info(`DSH model ids are the modelIds above (${collapsed.length} after collapsing duplicate providers).`)
  const summary = {
    command: 'models',
    ok: true,
    facts: {
      zcodeCliPath: cliPath,
      models: collapsed.map((entry) => ({
        providerId: entry.providerId,
        modelId: entry.modelId,
        contextWindow: entry.contextWindow ?? null,
        maxOutputTokens: entry.maxOutputTokens ?? null,
        reasoningLevels: entry.reasoningLevels,
        supportsImage: entry.supportsImage,
      })),
    },
  }
  io.report(summary)
  return summary
}

/**
 * One decoded JSON-RPC message.
 *
 * @typedef {object} ProbeMessage
 * @property {number | string | undefined} [id] Request/response id.
 * @property {string | undefined} [method] Method name.
 * @property {any} [params] Parameters.
 * @property {any} [result] Response result.
 * @property {{ message?: unknown } | undefined} [error] Response error.
 */

/** Handle on a spawned app-server used by the probes. */
class ProbeServer {
  /**
   * @param {string} cliPath Path to zcode.cjs.
   * @param {{ cwd?: string, env?: Record<string, string>, allowTools?: boolean }} [settings] Spawn settings.
   */
  constructor(cliPath, settings = {}) {
    /** Whether probes auto-approve tool permission requests (opt-in only). */
    this.allowTools = settings.allowTools === true
    this.nextId = 1
    /** @type {Map<number, { resolve: (value: any) => void, reject: (error: any) => void }>} */
    this.pending = new Map()
    /** @type {ProbeMessage[]} */
    this.events = []
    /** @type {Set<(message: ProbeMessage) => void>} */
    this.listeners = new Set()
    const env = { ...process.env, ...settings.env }
    delete env.ELECTRON_RUN_AS_NODE
    this.child = spawn(process.execPath, [cliPath, 'app-server', '--surface', 'terminal', '--no-color'], {
      cwd: settings.cwd ?? os.homedir(),
      env,
      windowsHide: true,
    })
    this.child.stdout.setEncoding('utf8')
    const reader = createInterface({ input: this.child.stdout })
    reader.on('line', (line) => this.onLine(line))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (/** @type {string} */ chunk) => {
      const text = chunk.trim()
      if (text !== '') this.events.push({ method: 'stderr', params: text.slice(0, 400) })
    })
    this.child.on('exit', (/** @type {number | null} */ code) => {
      for (const entry of this.pending.values()) entry.reject(new Error(`app-server exited (code=${code})`))
      this.pending.clear()
    })
  }

  /**
   * Parse one stdout line.
   *
   * @param {string} line One line of stdout.
   * @returns {void}
   */
  onLine(line) {
    const text = line.trim()
    if (text === '') return
    /** @type {ProbeMessage} */
    let message
    try {
      message = JSON.parse(text)
    } catch {
      this.events.push({ method: 'raw', params: text.slice(0, 400) })
      return
    }
    if (message.id !== undefined && message.method === undefined) {
      const entry = this.pending.get(Number(message.id))
      if (entry !== undefined) {
        this.pending.delete(Number(message.id))
        if (message.error !== undefined) entry.reject(new Error(String(message.error.message ?? 'rpc error')))
        else entry.resolve(message.result)
      }
      return
    }
    // A server-initiated request must be answered, or the agent stalls.
    if (message.method !== undefined && message.id !== undefined) {
      this.events.push({ method: `server-request:${message.method}`, params: message.params })
      this.write({ id: message.id, result: this.automaticReply(message.method, message.params) })
      return
    }
    if (message.method !== undefined) {
      this.events.push(message)
      for (const listener of this.listeners) listener(message)
    }
  }

  /**
   * Reply used by the probes for server-initiated requests (the same shape the bridge
   * sends, minus the real token).
   *
   * @param {string} method Requested method.
   * @param {any} params Request parameters.
   * @returns {any} Reply payload.
   */
  automaticReply(method, params) {
    if (method === 'session/requestRuntimePreferences') {
      return {
        nativeSearchEnhancementsEnabled: false,
        memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: true,
        modelContextBudgetStrategy: 'preflight-v1',
      }
    }
    // Diagnostic probes start a real app-server agent with this user's account, so they
    // follow the same fail-closed default as the plugin: a probe run is not a reason to
    // grant unattended tool execution. Pass `--allow-tools` to the probe commands to opt
    // in explicitly. Unknown `approvalMode` values fail closed here too (3.15+ kernels
    // may attach `user-once`, which a bare decision already satisfies).
    if (method === 'interaction/requestPermission') {
      const approvalMode = typeof params?.approvalMode === 'string' ? params.approvalMode : ''
      if (approvalMode !== '' && approvalMode !== 'user-once') {
        return { decision: 'deny', reason: `Unknown approvalMode "${approvalMode}"; denied by the diagnostic probe.` }
      }
      return this.allowTools
        ? { decision: 'allow' }
        : { decision: 'deny', reason: 'Diagnostic probes deny tool permission by default.' }
    }
    if (/approval|permission/i.test(method)) {
      return { decision: 'deny', reason: 'Unknown permission method; denied by the diagnostic probe.' }
    }
    if (method === 'interaction/browserList') return { browsers: [] }
    if (method === 'interaction/requestProviderRuntimeHeaders') {
      return { headersApplied: false, errorMessage: `diagnostic probe: not attaching credentials (${String(params?.sessionId ?? '')})` }
    }
    return {}
  }

  /**
   * Write one message to the child.
   *
   * @param {Record<string, unknown>} message Message to send.
   * @returns {void}
   */
  write(message) {
    this.child.stdin.write(JSON.stringify(message) + '\n')
  }

  /**
   * Send a request and await its response.
   *
   * @param {string} method Method name.
   * @param {unknown} params Parameters.
   * @param {number} [timeoutMs] Timeout (default 30s).
   * @returns {Promise<any>} Response result.
   */
  request(method, params, timeoutMs = 30_000) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.write({ id, method, params })
    })
  }

  /**
   * Run `action` and collect the notifications that arrive meanwhile.
   *
   * @param {(record: (message: ProbeMessage) => void) => Promise<void>} action Work to run.
   * @returns {Promise<ProbeMessage[]>} Notifications observed during the action.
   */
  async collect(action) {
    /** @type {ProbeMessage[]} */
    const collected = []
    /** @param {ProbeMessage} message */
    const listener = (message) => collected.push(message)
    this.listeners.add(listener)
    try {
      await action((message) => collected.push(message))
    } finally {
      this.listeners.delete(listener)
    }
    return collected
  }

  /**
   * Kill the child.
   *
   * @returns {void}
   */
  kill() {
    try {
      this.child.kill()
    } catch {
      /* Already gone. */
    }
  }
}

/**
 * Create a session the same way the bridge does, for probes that need one.
 *
 * @param {ProbeServer} server Spawned app-server.
 * @param {string} cliPath Path to zcode.cjs (unused; kept for symmetry with the CLI).
 * @returns {Promise<string>} The created sessionId.
 */
async function createProbeSession(server, cliPath) {
  void cliPath
  const workspacePath = os.homedir()
  const created = await server.request('session/create', {
    workspace: { workspacePath, workspaceKey: 'dsh-zcode-plan-bridge-diagnostics' },
  })
  const sessionId = created?.session?.sessionId
  if (typeof sessionId !== 'string' || sessionId === '') throw new Error('session/create returned no sessionId')
  await server.request('session/subscribe', {
    sessionId,
    deliveryKind: 'desktop-continuous',
    afterSeq: 0,
    includeSnapshot: true,
  })
  return sessionId
}

/**
 * `protocol`: start an app-server and report the message shapes it actually emits.
 *
 * This is the command that answers "did the client change its protocol?" -- the ten
 * original probe scripts existed because the envelope has no `jsonrpc` field, the event
 * type sits at `params.type` for GUI events but at `payload.type` for telemetry events,
 * and `session/setModel` needs its object form. Run this after a ZCode upgrade.
 *
 * @param {DiagnosticIo} io Output sink.
 * @param {DiagnosticOptions} [options] Configuration overrides.
 * @returns {Promise<DiagnosticSummary>} Collected facts.
 */
export async function protocol(io, options = {}) {
  const cliPath = locateZcodeCli(options.zcodeCliPath)
  if (cliPath === '') {
    io.fail('no ZCode CLI found (set zcodeCliPath or ZCODE_CLI_PATH)')
    const failed = { command: 'protocol', ok: false, facts: {} }
    io.report(failed)
    return failed
  }
  const server = new ProbeServer(cliPath, { allowTools: options.allowTools === true })
  try {
    io.info(`app-server ${cliPath}`)
    const startup = await server.collect(async () => {
      await new Promise((/** @type {(value?: void) => void} */ resolve) => setTimeout(resolve, 2500))
    })
    io.info(`startup notifications (${startup.length}):`)
    for (const message of startup.slice(0, 12)) {
      io.detail(`${message.method} ${JSON.stringify(message.params ?? {}).slice(0, 140)}`)
    }

    io.info('')
    io.info('session/create:')
    const sessionId = await createProbeSession(server, cliPath)
    io.detail(`sessionId ${sessionId}`)

    const shapes = new Map()
    const afterCreate = await server.collect(async () => {
      await new Promise((/** @type {(value?: void) => void} */ resolve) => setTimeout(resolve, 1500))
    })
    for (const message of afterCreate) {
      const type = message.params?.type ?? message.params?.payload?.type ?? '(none)'
      shapes.set(`${message.method}:${String(type)}`, (shapes.get(`${message.method}:${String(type)}`) ?? 0) + 1)
    }
    io.info('event shapes (method:type -> count):')
    for (const [shape, count] of shapes) io.detail(`${shape} -> ${count}`)

    io.info('')
    io.info('session/setModel (object form, reasoning level required):')
    try {
      const catalog = await probeCatalog(io, cliPath, options.allowTools === true)
      const entry = pickCatalogEntry(catalog, '')
      if (entry === undefined) {
        io.warn('   skipped: the CLI reported no models to select')
      } else {
        const level = entry.reasoningLevels.includes(DEFAULT_REASONING_LEVEL)
          ? DEFAULT_REASONING_LEVEL
          : (entry.defaultReasoningLevel ?? entry.reasoningLevels[0] ?? DEFAULT_REASONING_LEVEL)
        const result = await server.request('session/setModel', {
          sessionId,
          model: {
            providerId: entry.providerId,
            modelId: entry.modelId,
            options: { reasoningLevel: level },
          },
        })
        io.detail(`ok: ${entry.providerId}/${entry.modelId} (reasoning ${level}) ${JSON.stringify(result ?? {}).slice(0, 160)}`)
      }
    } catch (/** @type {any} */ error) {
      io.warn(`   refused: ${error?.message ?? error}`)
    }
    const facts = { eventShapes: Object.fromEntries(shapes), sessionId }
    const summary = { command: 'protocol', ok: true, facts }
    io.report(summary)
    return summary
  } finally {
    server.kill()
  }
}

/**
 * `turn`: run one real turn through the channel and report where it routed.
 *
 * This is the only check that proves the whole chain works (spawn -> create ->
 * subscribe -> send -> stream -> usage), and the reported `providerId`/`baseURL` is
 * what tells you which quota it actually spent.
 *
 * @param {DiagnosticIo} io Output sink.
 * @param {string} prompt Prompt text.
 * @param {DiagnosticOptions} [options] Configuration overrides and model selection.
 * @returns {Promise<DiagnosticSummary>} Collected facts.
 */
export async function turn(io, prompt, options = {}) {
  const cliPath = locateZcodeCli(options.zcodeCliPath)
  if (cliPath === '') {
    io.fail('no ZCode CLI found (set zcodeCliPath or ZCODE_CLI_PATH)')
    const failed = { command: 'turn', ok: false, facts: {} }
    io.report(failed)
    return failed
  }
  // Spawn with the inherited environment: the CLI is a standalone agent and resolves its
  // own account. Adding ZCODE_* overrides here would reproduce the failure mode the
  // bridge deliberately avoids (see lib/app-server.js start()).
  const server = new ProbeServer(cliPath, { allowTools: options.allowTools === true })
  /** @type {Record<string, unknown>} */
  const facts = {}
  try {
    io.info(`app-server ${cliPath}`)
    await new Promise((/** @type {(value?: void) => void} */ resolve) => setTimeout(resolve, 2500))
    const created = await server.request('session/create', {
      workspace: { workspacePath: os.homedir(), workspaceKey: 'dsh-zcode-plan-bridge-diagnostics' },
    })
    const sessionId = created?.session?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') {
      io.fail('session/create returned no sessionId')
      const failed = { command: 'turn', ok: false, facts: { zcodeCliPath: cliPath } }
      io.report(failed)
      return failed
    }
    await server.request('session/subscribe', {
      sessionId,
      deliveryKind: 'desktop-continuous',
      afterSeq: 0,
      includeSnapshot: true,
    })
    io.detail(`session ${sessionId}`)
    await new Promise((/** @type {(value?: void) => void} */ resolve) => setTimeout(resolve, 1500))

    // Pick the route from the catalogue the CLI just reported, exactly like the bridge:
    // `options.model` may be a bare model id (matched against the catalogue) or empty, in
    // which case the account's own default provider wins.
    const catalog = readModelCatalog(created)
    const route = pickCatalogEntry(catalog, options.model ?? '')
    if (route === undefined) {
      io.warn(`   model "${options.model ?? '(default)'}" not found in the CLI catalogue; the session keeps its default model`)
    } else {
      const level = route.reasoningLevels.includes(DEFAULT_REASONING_LEVEL)
        ? DEFAULT_REASONING_LEVEL
        : (route.defaultReasoningLevel ?? route.reasoningLevels[0] ?? DEFAULT_REASONING_LEVEL)
      try {
        await server.request('session/setModel', {
          sessionId,
          model: { providerId: route.providerId, modelId: route.modelId, options: { reasoningLevel: level } },
        })
        io.detail(`model ${route.providerId}/${route.modelId} (reasoning ${level})`)
      } catch (/** @type {any} */ error) {
        io.warn(`   setModel failed, the session keeps its default model: ${error?.message ?? error}`)
      }
    }

    /** @type {{ response?: string, resultType?: string, providerId?: unknown, modelId?: unknown, baseURL?: unknown, usage?: any }} */
    const observed = {}
    let chunks = 0
    /** @param {ProbeMessage} message */
    const watch = (message) => {
      if (message.method !== 'session/event') return
      const payload = message.params?.payload
      const type = message.params?.type ?? payload?.type
      if (type === 'session.updated' && typeof payload?.baseURL === 'string') {
        observed.providerId = payload.providerId
        observed.modelId = payload.modelId
        observed.baseURL = payload.baseURL
      } else if (type === 'model.streaming' && payload?.done !== true) {
        chunks += 1
      } else if (type === 'turn.completed') {
        observed.response = payload?.response
        observed.resultType = payload?.resultType
        observed.usage = payload?.usage
      } else if (type === 'turn.failed') {
        observed.resultType = 'failed'
        observed.response = String(payload?.error?.message ?? payload?.error?.code ?? 'unknown')
      }
    }
    server.listeners.add(watch)
    io.info('')
    io.info(`sending: ${prompt}`)
    await server.request('session/send', { sessionId, content: prompt }, 60_000)
    const deadline = Date.now() + 180_000
    while (observed.resultType === undefined && Date.now() < deadline) {
      await new Promise((/** @type {(value?: void) => void} */ resolve) => setTimeout(resolve, 500))
    }
    server.listeners.delete(watch)
    if (observed.resultType === undefined) {
      io.fail('the turn did not finish within 180s')
      const timeout = { command: 'turn', ok: false, facts: { ...facts, streamingChunks: chunks } }
      io.report(timeout)
      return timeout
    }
    io.info(`result ${String(observed.resultType)}, ${chunks} streaming deltas`)
    io.detail(`providerId ${String(observed.providerId ?? '?')}`)
    io.detail(`model      ${String(observed.modelId ?? '?')}`)
    io.detail(`baseURL    ${String(observed.baseURL ?? '?')}`)
    if (observed.usage !== undefined) io.detail(`usage      ${JSON.stringify(observed.usage)}`)
    if (typeof observed.response === 'string' && observed.response !== '') {
      io.info('response:')
      io.detail(observed.response.slice(0, 600))
    }
    const summary = {
      command: 'turn',
      ok: observed.resultType === 'success',
      facts: { ...facts, ...observed, streamingChunks: chunks, sessionId },
    }
    io.report(summary)
    return summary
  } finally {
    server.kill()
  }
}

/**
 * `image`: verify the image-attachment route.
 *
 * Measured constraint the bridge works around: neither a data URL inside `content` nor
 * `session/send`'s attachments parameter works, so the bridge writes local files and
 * tells the agent to `Read` them. This command checks that a real file reaches the
 * model, which is exactly what that workaround depends on.
 *
 * @param {DiagnosticIo} io Output sink.
 * @param {string} imagePath Absolute path to a PNG/JPEG/WebP/GIF.
 * @param {DiagnosticOptions} [options] Configuration overrides.
 * @returns {Promise<DiagnosticSummary>} Collected facts.
 */
export async function image(io, imagePath, options = {}) {
  const cliPath = locateZcodeCli(options.zcodeCliPath)
  if (cliPath === '') {
    io.fail('no ZCode CLI found (set zcodeCliPath or ZCODE_CLI_PATH)')
    const failed = { command: 'image', ok: false, facts: {} }
    io.report(failed)
    return failed
  }
  if (!fs.existsSync(imagePath)) {
    io.fail(`image not found: ${imagePath}`)
    const failed = { command: 'image', ok: false, facts: { imagePath } }
    io.report(failed)
    return failed
  }
  const server = new ProbeServer(cliPath, { allowTools: options.allowTools === true })
  try {
    io.info(`app-server ${cliPath}`)
    await new Promise((/** @type {(value?: void) => void} */ resolve) => setTimeout(resolve, 2500))
    const sessionId = await createProbeSession(server, cliPath)
    await new Promise((/** @type {(value?: void) => void} */ resolve) => setTimeout(resolve, 1500))
    const content = [
      'Read the image file below with your Read tool, then describe it in one sentence.',
      `Path: ${imagePath}`,
    ].join('\n')
    io.info(`sending image path: ${imagePath}`)
    /** @type {{ response?: string, resultType?: string }} */
    const observed = {}
    /** @param {ProbeMessage} message */
    const watch = (message) => {
      if (message.method !== 'session/event') return
      const type = message.params?.type ?? message.params?.payload?.type
      if (type === 'turn.completed') {
        observed.response = String(message.params?.payload?.response ?? '')
        observed.resultType = String(message.params?.payload?.resultType ?? 'success')
      } else if (type === 'turn.failed') {
        observed.resultType = 'failed'
        observed.response = String(message.params?.payload?.error?.message ?? 'failed')
      }
    }
    server.listeners.add(watch)
    await server.request('session/send', { sessionId, content }, 60_000)
    const deadline = Date.now() + 180_000
    while (observed.resultType === undefined && Date.now() < deadline) {
      await new Promise((/** @type {(value?: void) => void} */ resolve) => setTimeout(resolve, 500))
    }
    server.listeners.delete(watch)
    const ok = observed.resultType === 'success'
    if (observed.resultType === undefined) io.fail('the turn did not finish within 180s')
    else if (ok) {
      io.info('the model processed the image path:')
      io.detail(String(observed.response ?? '').slice(0, 600))
    } else {
      io.fail(`the turn failed: ${String(observed.response ?? '')}`)
    }
    const summary = { command: 'image', ok, facts: { imagePath, ...observed } }
    io.report(summary)
    return summary
  } finally {
    server.kill()
  }
}

/**
 * Subcommands accepted by the CLI, with a one-line description each.
 *
 * @type {readonly { name: string, summary: string, usage: string }[]}
 */
export const COMMANDS = [
  { name: 'doctor', summary: 'Check every local precondition (offline)', usage: 'doctor [--data-dir <dir>]' },
  { name: 'models', summary: 'Show the model catalogue the CLI reports (offline, no quota)', usage: 'models [--cli-path <zcode.cjs>]' },
  { name: 'protocol', summary: 'Start an app-server and report the message shapes it emits (free)', usage: 'protocol' },
  { name: 'turn', summary: 'Run one real turn and report the channel and usage (spends quota)', usage: 'turn [prompt] [--model <id>]' },
  { name: 'image', summary: 'Verify a local image reaches the model (spends quota)', usage: 'image <path>' },
]

/**
 * The one flag that applies to every command, described once.
 *
 * Probes spawn a real agent with this user's account, so tool permission requests are
 * denied unless this flag is present; without it a `turn`/`image` run cannot use Bash,
 * file writes or networking.
 */
export const TOOL_FLAG_NOTE =
  '--allow-tools  let the probed agent run tools (Bash, files, network); denied by default'

/**
 * Parse `--flag value` pairs and positionals.
 *
 * @param {readonly string[]} argv Raw arguments after the subcommand.
 * @returns {{ options: Record<string, string>, positional: string[] }} Parsed arguments.
 */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const options = {}
  /** @type {string[]} */
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const name = token.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        options[name] = next
        i += 1
      } else {
        options[name] = 'true'
      }
    } else {
      positional.push(token)
    }
  }
  return { options, positional }
}

/**
 * CLI entry point.
 *
 * @param {readonly string[]} argv Arguments after the script path.
 * @param {{ info?: (line: string) => void, json?: boolean }} [settings] Output settings.
 * @returns {Promise<number>} Process exit code.
 */
export async function runCli(argv, settings = {}) {
  const json = settings.json === true || argv.includes('--json')
  // Boolean flags are stripped before positional parsing: parseArgs treats any `--name`
  // followed by a non-flag token as taking a value, so leaving `--allow-tools image x.png`
  // in place would consume the path.
  const allowTools = argv.includes('--allow-tools')
  const clean = argv.filter((token) => token !== '--json' && token !== '--allow-tools')
  const command = clean[0]
  const rest = clean.slice(1)
  const { options, positional } = parseArgs(rest)
  /** @type {DiagnosticSummary | undefined} */
  let last
  /** @type {DiagnosticIo} */
  const io = {
    ...consoleIo,
    info: settings.info ?? consoleIo.info,
    report: (summary) => {
      last = summary
    },
  }
  const config = {
    zcodeCliPath: options['cli-path'],
    zcodeDataBaseDir: options['data-dir'],
    model: options.model,
    allowTools,
  }
  let code = 0
  switch (command) {
    case 'doctor':
      code = (await doctor(io, config)).ok ? 0 : 1
      break
    case 'models':
      code = (await models(io, config)).ok ? 0 : 1
      break
    case 'protocol':
      code = (await protocol(io, config)).ok ? 0 : 1
      break
    case 'turn': {
      const prompt = positional.join(' ').trim() || 'Reply with exactly: pong'
      code = (await turn(io, prompt, config)).ok ? 0 : 1
      break
    }
    case 'image': {
      const imagePath = positional[0]
      if (imagePath === undefined) {
        consoleIo.fail('usage: image <path>')
        return 2
      }
      code = (await image(io, path.resolve(imagePath), config)).ok ? 0 : 1
      break
    }
    default:
      consoleIo.info('dsh-zcode-plan-bridge — diagnostics for the ZCode Start Plan channel')
      consoleIo.info('')
      consoleIo.info('Commands:')
      for (const entry of COMMANDS) {
        consoleIo.info(`  ${entry.usage}`)
        consoleIo.detail(entry.summary)
      }
      consoleIo.info('')
      consoleIo.info(`  ${TOOL_FLAG_NOTE}`)
      return command === undefined || command === 'help' || command === '--help' ? 0 : 2
  }
  if (json && last !== undefined) console.log(JSON.stringify(last, null, 2))
  return code
}
