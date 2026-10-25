/**
 * App-server bridge: a resident `zcode app-server` process spoken to over
 * ZCode Protocol (stdio JSON-RPC).
 *
 * Why the resident app-server rather than one-shot `-p` calls:
 *   - resident process: no restart per turn (saves process start-up plus ~15k
 *     of repeated context every turn)
 *   - real streaming: session/event -> model.streaming text_delta / reasoning_delta
 *     is forwarded straight to DSH
 *   - session reuse: one app-server session per DSH sessionId, later turns resume
 *   - observability: session.updated carries providerId / baseURL, so it is
 *     always clear which channel's quota a turn spent
 *
 * Protocol (measured; the bundle's schema confirms it):
 *   envelope  request {id, method, params}; notification {method, params};
 *             response {id, result|error} -- there is no jsonrpc field
 *   session/create {workspace:{workspacePath, workspaceKey}} -> result.session.sessionId
 *   server request session/requestRuntimePreferences {sessionId, scope}
 *             -> must reply {nativeSearchEnhancementsEnabled, memoryEnabled,
 *                askUserQuestionAutoResolutionEnabled, modelContextBudgetStrategy}
 *   session/subscribe {sessionId, deliveryKind:'desktop-continuous', afterSeq, includeSnapshot}
 *   session/setModel {sessionId, model:{providerId, modelId, options?:{reasoningLevel}}}
 *             (object form required since 0.16.9)
 *   session/send {sessionId, content}
 *   events    session/event: **type is at the params top level** (params.type),
 *             data in params.payload --
 *             session.titleUpdated | turn.started | session.updated
 *             | model.streaming{kind,delta,done}
 *             | turn.completed{response,usage,resultType} | turn.failed{error}
 *             (there are also model_request_started/failed telemetry events whose
 *             payload.type sits one level in, coexisting with the GUI events)
 *
 * Channel selection (re-measured 2026-10-21 on zcode-app-cli 3.14.4-30):
 *   The CLI runs as a **standalone** agent: it resolves its own account, its own
 *   provider registry and its own model catalogue, and it reports the result back in
 *   `session/create` -> `result.settings.model.available`. The bridge therefore does not
 *   inject anything. An earlier version injected `provider/updateAccountConfig` to
 *   register `account:zai-start-plan`; that path is dead on the npm build --
 *   `syncAccountProviderConfig` throws "Standalone Account 由本进程管理，不接收 Host 覆盖"
 *   whenever a standalone account source exists, which it always does for `app-server`.
 *   `providerId` is likewise whatever the CLI reports (`account:zai-individual-coding-plan`,
 *   `zai-api`, ...), never a constant: a hard-coded id silently mismatches.
 *   1. spawn the CLI with no ZCODE_* overrides (see start()).
 *   2. read the catalogue from session/create; pick provider+model from it.
 *   3. session/setModel only when the session is not already on that route.
 *   4. before each model request the agent may call back into
 *      interaction/requestProviderRuntimeHeaders for auth -- reply with **zcodejwttoken**
 *      (the `zcodejwttoken` key of the shared credentials). oauth:zai:access_token is the
 *      expired OAuth session token; replying with it earns a 401. Standalone sessions
 *      usually sign requests themselves and never ask.
 *
 * @module lib/app-server
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'

import { flattenConversation, lastUserText, materializeImages, removeFiles, sanitizeLeakedCalls } from './messages.js'
import { CredentialError, readZaiPlanAuth } from './credentials.js'
import { prepareStartPlan } from './start-plan.js'
import { modeForPolicy, permissionResponse } from './authorization.js'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_REASONING_LEVEL,
  FALLBACK_CATALOG,
  MODEL_MODALITIES,
  collapseCatalog,
  pickCatalogEntry,
  readCurrentModel,
  readModelCatalog,
  resolveBuiltinRuntime,
} from './zcode-runtime.js'

/**
 * @typedef {import('@deepseek-ai/dsh-llm').GenerateOptions} GenerateOptions
 * @typedef {import('@deepseek-ai/dsh-llm').StreamChunk} StreamChunk
 * @typedef {import('@deepseek-ai/dsh-llm').LlmModelInfo} LlmModelInfo
 * @typedef {import('@deepseek-ai/dsh-llm').LlmResolvedModelInfo} LlmResolvedModelInfo
 * @typedef {import('@deepseek-ai/dsh-llm').LlmProviderInfo} LlmProviderInfo
 * @typedef {import('@deepseek-ai/dsh-llm').ResolvedRetryPolicy} ResolvedRetryPolicy
 * @typedef {import('./index.js').ResolvedOptions} ResolvedOptions
 * @typedef {import('./index.js').CliModel} CliModel
 * @typedef {import('./messages.js').BridgeLogger} BridgeLogger
 * @typedef {import('./messages.js').ImageAttachmentSource} ImageAttachmentSource
 * @typedef {import('./messages.js').MaterializedImages} MaterializedImages
 */

/**
 * Runtime information the adapter needs from the resolved plugin configuration.
 *
 * @typedef {object} AdapterDeps
 * @property {() => ResolvedOptions} options Resolve the current configuration.
 * @property {() => ImageAttachmentSource | undefined} [resolveAttachments] Durable attachment service (image reads).
 * @property {BridgeLogger | undefined} [logger] Structured logger.
 */

/**
 * One JSON-RPC message received from the app-server.
 *
 * @typedef {object} RpcMessage
 * @property {number | string | undefined} [id] Request or response id.
 * @property {string | undefined} [method] Method name; absent on responses.
 * @property {any} [params] Notification or request parameters.
 * @property {any} [result] Response payload.
 * @property {{ message?: unknown, code?: unknown } | undefined} [error] Response error payload.
 */

/** A pending request awaiting its response. */
/** @typedef {{ resolve: (value: any) => void, reject: (error: any) => void }} PendingEntry */

/** Notification listener. @typedef {(message: RpcMessage) => void} NotificationListener */

/**
 * A ZCode builtin runtime directory candidate.
 *
 * @typedef {import('./zcode-runtime.js').BuiltinRuntime} BuiltinRuntime
 */

/**
 * Per-DSH-session app-server session bookkeeping.
 *
 * @typedef {object} SessionEntry
 * @property {string} sessionId app-server session id.
 * @property {boolean} firstTurn Whether the next send must replay the whole conversation.
 * @property {string} providerId CLI-side provider currently selected.
 * @property {string} modelId CLI-side model currently selected.
 * @property {'deny' | 'allow-all'} authorizationPolicy Permission mode last synchronized to this session.
 * @property {number} [sentLength] Message count at the last successful send.
 * @property {string} [sentFingerprint] Conversation fingerprint at the last successful send.
 */

/** One queued stream delta. @typedef {{ kind: 'text' | 'reasoning', text: string }} QueueItem */

/** Terminal turn description. @typedef {{ response: string, resultType: string, error: string | undefined }} TurnResult */

/** Observed execution channel. @typedef {{ providerId?: unknown, modelId?: unknown, baseURL?: unknown }} TurnChannel */

/** Handle that wakes an in-flight stream when the child dies. @typedef {{ onDeath: () => void }} StreamHandle */

const RUNTIME_PREFERENCES = {
  nativeSearchEnhancementsEnabled: false,
  memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: true,
  modelContextBudgetStrategy: 'preflight-v1',
}

/**
 * An app-server session allows only one in-flight turn. When the previous turn was
 * aborted, timed out, or silently dropped, its turn lock is never released and the
 * next send is refused with `A prompt is already running for this session`.
 */
const STUCK_TURN_ERROR = /already running|already in flight|still running|in progress|is busy/i
/** The session no longer exists on the app-server side (process restart, reclamation) -- only a rebuild can recover. */
const STALE_SESSION_ERROR = /not found|unknown session|no such session|does not exist|invalid session/i
/** Grace period between stop and retry, while the agent releases its turn lock (milliseconds). */
const STOP_SETTLE_MS = 1500
/**
 * Upper bound on waiting for the previous turn (milliseconds). DSH already serialises
 * prompts within one session, so actually queueing usually means the previous turn's
 * generator was abandoned (the consumer never reached `finally`); waiting longer is
 * worse than releasing and letting stuck-turn recovery deal with it.
 */
const TURN_QUEUE_MAX_MS = 60_000

/**
 * Resolve after a delay.
 *
 * @param {number} ms Delay in milliseconds.
 * @returns {Promise<void>} Completion after the delay.
 */
const sleep = (ms) => new Promise((/** @type {(value?: void) => void} */ resolve) => setTimeout(resolve, ms))

/**
 * Wait for a promise to settle, at most `ms` milliseconds; a timeout is not a failure
 * (turn queueing must not deadlock).
 *
 * @param {Promise<unknown>} promise Promise to await.
 * @param {number} ms Maximum wait in milliseconds.
 * @returns {Promise<void>} Completion after settlement or timeout.
 */
function settleWithin(promise, ms) {
  return new Promise((/** @type {(value?: void) => void} */ resolve) => {
    const timer = setTimeout(() => resolve(), ms)
    /** @returns {void} */
    const done = () => {
      clearTimeout(timer)
      resolve()
    }
    promise.then(done, done)
  })
}

/**
 * Child-process environment whitelist: the host (DSH) process env may carry other
 * providers' keys, so the agent does not get the whole thing. Only system basics,
 * `ZCODE_*`, and NODE_EXTRA_CA_CERTS pass; the `childEnvAllow` option adds names.
 * Keys compare lowercased but pass through with their original casing (Windows env
 * keys are case-insensitive).
 */
const CHILD_ENV_BASE = new Set([
  'path', 'pathext', 'systemroot', 'systemdrive', 'windir', 'comspec',
  'homedrive', 'homepath', 'userprofile', 'appdata', 'localappdata',
  'programfiles', 'programfiles(x86)', 'commonprogramfiles',
  'commonprogramfiles(x86)', 'programdata', 'allusersprofile',
  'temp', 'tmp', 'os', 'username', 'userdomain', 'computername',
  'processor_architecture', 'number_of_processors',
  'lang', 'lc_all', 'lc_ctype', 'term', 'psmodulepath',
  'node_extra_ca_certs',
])

/**
 * Build the filtered child environment.
 *
 * @param {Record<string, string>} overrides Variables the bridge forces.
 * @param {readonly string[] | undefined} extraAllow Extra names from configuration.
 * @returns {Record<string, string>} Whitelisted environment.
 */
function buildChildEnv(overrides, extraAllow) {
  const allow = new Set(CHILD_ENV_BASE)
  for (const key of extraAllow ?? []) {
    if (typeof key === 'string' && key.trim() !== '') allow.add(key.trim().toLowerCase())
  }
  /** @type {Record<string, string>} */
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    const lower = key.toLowerCase()
    if (allow.has(lower) || lower.startsWith('zcode_')) env[key] = value
  }
  Object.assign(env, overrides)
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

/** A resident app-server process plus JSON-RPC send/receive. */
class AppServerClient {
  /**
   * @param {AdapterDeps} deps Resolved options, logger.
   */
  constructor({ options, logger }) {
    this.options = options
    this.logger = logger
    /** @type {import('node:child_process').ChildProcessWithoutNullStreams | undefined} */
    this.child = undefined
    this.nextId = 1
    /** @type {Map<number, PendingEntry>} */
    this.pending = new Map()
    /** @type {Set<NotificationListener>} */
    this.listeners = new Set()
    this.buffer = ''
    /** @type {Promise<void> | undefined} */
    this.starting = undefined
    this.disposed = false
    /** Callback fired when the child exits: the adapter drops its now-dangling session map. */
    /** @type {(() => void) | undefined} */
    this.onExit = undefined
    /** Last observed execution channel, for diagnosing which quota a turn burned. */
    /** @type {TurnChannel | undefined} */
    this.lastChannel = undefined
    /** Builtin runtime fixed at spawn time, used for app-version and diagnostics. */
    /** @type {BuiltinRuntime | undefined} */
    this.builtin = undefined
    /** Catalogue the CLI reported for this account (cached; the CLI owns it). */
    /** @type {import('./zcode-runtime.js').CatalogEntry[] | undefined} */
    this.catalog = undefined
    /** In-flight catalogue read, so concurrent `listModels` calls share one session. */
    /** @type {Promise<import('./zcode-runtime.js').CatalogEntry[]> | undefined} */
    this.catalogRead = undefined
  }

  /**
   * Start the child if it is not running.
   *
   * @returns {Promise<void>} Completion once the child is ready.
   */
  async ensureStarted() {
    if (this.starting !== undefined) return this.starting
    if (this.child !== undefined) return
    this.starting = this.start().catch(error => {
      this.child?.kill()
      this.child = undefined
      throw error
    }).finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  /**
   * Spawn the app-server and push the Start Plan account into it.
   *
   * @returns {Promise<void>} Completion once the agent runtime is ready.
   * @throws {LlmError} When the CLI binary is missing.
   */
  async start() {
    const options = this.options()
    if (!fs.existsSync(options.zcodeCliPath)) {
      throw new LlmError(`找不到 ZCode CLI：${options.zcodeCliPath}`, 'PROVIDER')
    }
    // Standalone mode inherits the CLI's account ownership. Start Plan explicitly
    // opts into the npm CLI's native host mode below, with matching builtin and
    // isolated Personal Config files plus server-verified account entitlements.
    //
    // Measured on zcode-app-cli 3.14.4-30: setting ZCODE_BUILTIN_PROVIDER_CONFIG_FILE and
    // ZCODE_PERSONAL_PROVIDER_CONFIG_FILE together makes the CLI resolve both releases
    // strictly; the desktop client downloads releases whose schema this CLI build cannot
    // decode, both resolutions fail, and the process dies with "Bundled 与 Active ZCode
    // Built-in Release 均不可用" before serving a single request. Setting only the bundled
    // file is silently ignored ("ZCode Built-in skipped (not-due)"), and setting the
    // authority mode plus a base URL changes nothing at all: three environments (empty,
    // authority only, authority+base URL) produced byte-identical catalogues.
    //
    // So the child inherits the environment as-is and resolves its own account and its
    // own release. The plugin inspects those files for diagnostics only; it never feeds
    // them to the child.
    this.builtin = resolveBuiltinRuntime(options.zcodeDataBaseDir || undefined, options.zcodeCliPath)
    const startPlan = options.accountMode === 'start-plan'
      ? await prepareStartPlan(this.builtin, options.zcodeDataBaseDir)
      : undefined
    const env = buildChildEnv(startPlan?.env ?? {}, options.childEnvAllow)
    if (this.builtin !== undefined) {
      const revision = this.builtin.revision === undefined ? 'unversioned' : `revision ${this.builtin.revision}`
      this.logger?.info?.(`zcode: builtin runtime ${this.builtin.version} available (${revision}, ${this.builtin.source}: ${this.builtin.activeFilePath})`)
    } else {
      this.logger?.debug?.('zcode: no zcode-builtin.json found; the CLI will use its own bundled release')
    }

    // Note: do not add --browser-use headless -- app-server only accepts it together
    // with -p/--target/tui and exits with code=1 otherwise. This session's browser goes
    // through interaction/browser* to the host; when the host (this plugin) returns an
    // empty list or refuses, the tool degrades gracefully to unavailable.
    const child = spawn(options.zcodeCliNode, [options.zcodeCliPath, 'app-server', '--surface', 'terminal', '--no-color'], {
      cwd: options.cliCwd !== '' ? options.cliCwd : os.homedir(),
      env,
      windowsHide: true,
    })
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (/** @type {string} */ chunk) => this.onData(chunk))
    child.stderr.on('data', (/** @type {Buffer | string} */ chunk) => {
      const text = String(chunk).trim()
      if (text !== '') this.logger?.debug?.(`zcode app-server: ${text.slice(0, 200)}`)
    })
    child.on('exit', (/** @type {number | null} */ code) => {
      this.logger?.warn?.(`zcode app-server exited (code=${code}), the next call restarts it`)
      for (const { reject } of this.pending.values()) reject(new LlmError('app-server 已退出', 'TRANSPORT'))
      this.pending.clear()
      this.child = undefined
      // The process is gone, so every cached sessionId dangles: keeping them would
      // turn the next turn into "session does not exist".
      try {
        this.onExit?.()
      } catch {
        /* A cleanup callback must not break send/receive. */
      }
    })
    // A failed spawn (wrong node path, EPERM from a sandbox, ...) is an 'error' event:
    // unhandled, it would take the host process down with it. Handle it as an ordinary
    // failure and retry next turn.
    child.on('error', (/** @type {any} */ error) => {
      this.logger?.error?.(`zcode: app-server failed to start: ${error?.message ?? error}`)
      for (const { reject } of this.pending.values()) reject(new LlmError(`app-server 启动失败：${error?.message ?? error}`, 'TRANSPORT'))
      this.pending.clear()
      this.child = undefined
      try {
        this.onExit?.()
      } catch {
        /* A cleanup callback must not break send/receive. */
      }
    })
    this.logger?.info?.(`zcode: app-server started (pid ${child.pid})`)

    // Wait for the agent runtime: the storageState notification reaches phase=ready,
    // or 8s elapse. Creating and sending without waiting makes the turn be dropped
    // silently (measured: it hangs right after `send accepted`).
    await new Promise((/** @type {(value?: void) => void} */ resolve) => {
      let settled = false
      /** @returns {void} */
      const finish = () => {
        if (settled) return
        settled = true
        this.listeners.delete(listener)
        resolve()
      }
      /** @param {RpcMessage} message */
      const listener = (message) => {
        if (message.method === undefined) return
        const phase = message.params?.phase
        if (/^startup\//.test(String(message.method)) && (phase === 'ready' || phase === 'committing')) {
          finish()
        }
      }
      this.listeners.add(listener)
      setTimeout(finish, 8000)
    })
    this.logger?.info?.('zcode: app-server runtime ready')
    // Measured timing: a ~2.5s settling period follows readiness; replicate it. Sending
    // before the runtime settles makes the first turn be dropped silently.
    await sleep(2500)
    if (startPlan !== undefined) {
      await this.request('provider/updateAccountConfig', startPlan.account, options.appServerTimeoutMs)
      this.logger?.info?.('zcode: native Host account configured for Start Plan')
    }
  }

  /**
   * Feed one stdout chunk through the newline-delimited JSON parser.
   *
   * @param {string} chunk Decoded stdout text.
   * @returns {void}
   */
  onData(chunk) {
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      index = this.buffer.indexOf('\n')
      if (line === '') continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      this.dispatch(message)
    }
  }

  /**
   * Route one decoded message: response, server-initiated request, or notification.
   *
   * @param {RpcMessage} message Decoded message.
   * @returns {void}
   */
  dispatch(message) {
    // A response to one of our requests.
    if (message.id !== undefined && message.method === undefined) {
      const entry = this.pending.get(/** @type {number} */ (message.id))
      if (entry !== undefined) {
        this.pending.delete(/** @type {number} */ (message.id))
        if (message.error !== undefined) entry.reject(new LlmError(String(message.error.message ?? 'app-server 错误'), 'PROVIDER'))
        else entry.resolve(message.result)
      }
      return
    }
    // A server -> client request.
    if (message.method !== undefined && message.id !== undefined) {
      this.logger?.info?.(`zcode: server request ${message.method} ${JSON.stringify(message.params ?? {}).slice(0, 160)}`)
      if (message.method === 'session/requestRuntimePreferences') {
        this.write({ id: message.id, result: RUNTIME_PREFERENCES })
      } else if (message.method === 'interaction/requestProviderRuntimeHeaders') {
        // The agent asks the host for auth before each model request (the GUI's chain):
        // reply with zcodejwttoken. Note it is the shared credential's `zcodejwttoken`,
        // not `oauth:zai:access_token` -- that OAuth session token is expired and
        // replying with it earns a 401 upstream (measured).
        this.handleRuntimeHeadersRequest(message).catch(() => {})
      } else if (message.method === 'interaction/requestPermission') {
        this.write({ id: message.id, result: permissionResponse(message.method, this.options().authorizationPolicy, message.params) })
      } else if (message.method === 'interaction/browserList') {
        // The host offers no browser integration: reply with an empty list and let the
        // agent fall back to its own headless browser-use backend.
        this.write({ id: message.id, result: { browsers: [] } })
      } else if (message.method === 'interaction/browserExecute') {
        this.write({
          id: message.id,
          result: { ok: false, error: { code: 'host_unavailable', message: '宿主不提供浏览器集成，请使用 agent 自带浏览器' } },
        })
      } else if (/approval|permission/i.test(message.method)) {
        // Unknown permission-shaped requests are denied even in full-auto mode: their
        // response contract and effects are not understood by this bridge.
        this.write({ id: message.id, result: permissionResponse(message.method, this.options().authorizationPolicy, message.params) })
      } else {
        this.write({ id: message.id, result: {} })
      }
      return
    }
    // A notification.
    if (message.method !== undefined) {
      for (const listener of this.listeners) {
        try {
          listener(message)
        } catch {
          /* One listener's exception must not break send/receive. */
        }
      }
    }
  }

  /**
   * Write one JSON-RPC message to the child's stdin.
   *
   * @param {Record<string, unknown>} message Message to send.
   * @returns {void}
   */
  write(message) {
    this.child?.stdin.write(JSON.stringify(message) + '\n')
  }

  /**
   * Answer interaction/requestProviderRuntimeHeaders: the agent asks the host for auth
   * before each model request (the GUI's chain). The response matches zcode.cjs' DGt
   * schema, `{ headersApplied, requestAuth:{apiKey,headers?} }`; the agent signs the
   * coding-plan request itself (x-client-sig etc.) and passes the upstream WAF.
   *
   * @param {RpcMessage} message The server request.
   * @returns {Promise<void>} Completion after the reply is written.
   */
  async handleRuntimeHeadersRequest(message) {
    try {
      const options = this.options()
      const auth = readZaiPlanAuth(options.zcodeDataBaseDir)
      this.logger?.info?.(`zcode: returning Start Plan auth (activeProvider=${auth.activeProvider ?? '?'}, token ${auth.planToken.length} chars)`)
      // The user-agent has to look like a real client build or the upstream WAF answers
      // 3007/3012. Prefer the builtin release directory name (it tracks client upgrades);
      // hard-coding a version would drift on the next update. The literal is the runtime-CLI
      // line shipped with kernel 3.16.x, only used when no builtin could be located at all.
      const appVersion = this.builtin?.version ?? '0.17.0'
      this.write({
        id: message.id,
        result: {
          headersApplied: true,
          requestAuth: {
            apiKey: auth.planToken,
            headers: {
              'http-referer': 'https://zcode.z.ai',
              'user-agent': `ZCode/${appVersion}`,
              'x-zcode-app-version': appVersion,
              'x-title': 'Z Code@cli',
            },
          },
        },
      })
    } catch (/** @type {any} */ error) {
      const detail = error instanceof CredentialError ? error.message : '宿主无法提供 Start Plan 鉴权'
      this.logger?.warn?.(`zcode: header request failed -> ${detail}`)
      // Refuse explicitly (headersApplied:false) so the agent uses its own fallback
      // instead of hanging.
      this.write({
        id: message.id,
        result: { headersApplied: false, errorMessage: detail },
      })
    }
  }

  /**
   * Send one JSON-RPC request and await its response.
   *
   * @param {string} method Method name.
   * @param {unknown} params Request parameters.
   * @param {number} timeoutMs Timeout in milliseconds.
   * @returns {Promise<any>} The response `result`.
   */
  request(method, params, timeoutMs) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new LlmError(`app-server ${method} 超时（${timeoutMs}ms）`, 'TIMEOUT'))
      }, timeoutMs)
      this.pending.set(id, {
        /** @param {any} value */
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        /** @param {any} error */
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.write({ id, method, params })
    })
  }

  /**
   * Subscribe to notifications.
   *
   * @param {NotificationListener} listener Notification handler.
   * @returns {() => void} Unsubscribe.
   */
  onNotification(listener) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Send one JSON-RPC notification (no response expected).
   *
   * @param {string} method Method name.
   * @param {unknown} params Notification parameters.
   * @returns {void}
   */
  notify(method, params) {
    this.write({ method, params })
  }

  /**
   * Kill the child and mark the client disposed.
   *
   * @returns {void}
   */
  dispose() {
    this.disposed = true
    try {
      this.child?.kill()
    } catch {
      /* Already gone. */
    }
    this.child = undefined
  }
}

/**
 * session/event's type sits at the params top level for GUI events, while some
 * telemetry events carry it in payload.type -- read both.
 *
 * @param {RpcMessage} message A session/event notification.
 * @returns {{ type: any, payload: any }} Event type and payload.
 */
function eventPayload(message) {
  const params = message.params ?? {}
  return { type: params.type ?? params.payload?.type, payload: params.payload ?? params }
}

/**
 * Conversation-structure fingerprint: role plus stable fields such as text and tool
 * names, ignoring image bytes and volatile per-block metadata. It detects DSH-side
 * session edits and rewinds -- splicing a new branch into the old app-server session
 * would be a silent fork, so a mismatch rebuilds the session and replays the first turn.
 *
 * @param {readonly any[] | undefined} messages Request messages.
 * @param {string | undefined} system System prompt text.
 * @returns {string} Hex SHA-256 digest.
 */
function conversationFingerprint(messages, system) {
  const hash = createHash('sha256').update('dsh-zcode-plan-bridge/v1')
  hash.update('\u0000system\u0000').update(String(system ?? ''))
  for (const message of messages ?? []) {
    hash.update(`\u0000role\u0000${String(message?.role ?? '')}`)
    const content = message?.content
    if (typeof content === 'string') {
      hash.update('\u0001').update(content)
      continue
    }
    if (!Array.isArray(content)) continue
    for (const block of content) {
      hash.update(`\u0002${block === null || typeof block !== 'object' ? 'raw' : String(block.type ?? '')}`)
      if (block === null || typeof block !== 'object') continue
      for (const field of ['text', 'name']) {
        if (typeof block[field] === 'string') hash.update(`\u0003${field}\u0000`).update(block[field])
      }
      if (block.arguments !== undefined) {
        hash.update('\u0003args\u0000')
          .update(typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments))
      }
    }
  }
  return hash.digest('hex')
}

/**
 * Bridge note: DSH's flattened system prompt carries DSH's own tool list
 * (pwsh/fs/web and friends) that does not exist inside the agent runtime, so the
 * model imitates them and emits `<antml:invoke name="pwsh">` as reply text (nobody
 * parses that, so the raw markup leaks into the DSH chat window and looks like
 * "tools do not work"). Attaching this note to the first turn pushes the model back
 * to its native tools.
 */
const BRIDGE_NOTE = `


# 宿主桥接说明（优先级高于上文系统提示中与之冲突的内容）
- 你实际运行在 ZCode agent 运行时里。你能真正调用的只有你的原生工具（Bash、Read、Write、Edit、Glob、Grep、WebSearch、WebFetch 等），用你原生的工具调用机制直接调用。
- 上文「# 系统提示」里列出的其他工具（pwsh、fs-local、str-replace-editor、web 等）属于宿主应用 DSH，在本运行时中不存在、不可调用：不要模仿它们的调用格式，更不要把 <antml:invoke> / <antml:parameter> 之类的调用文本当作回复正文输出。
- 需要同类能力时用原生等价物：跑 PowerShell / Python 命令用 Bash（如 powershell -Command "..."），读文件用 Read。
- 需要实际操作（读文件、跑命令、检索）时直接调用原生工具完成，然后用文字向用户汇报结果。`

/** Hard rule placed before the replayed content (primacy position; BRIDGE_NOTE sits last for recency). */
const TOOL_RULE_HEAD = `【工具规则 · 最高优先级】你运行在 ZCode agent 运行时，唯一可用的工具是你的原生工具（Bash、Read、Write、Edit、Glob、Grep、WebSearch、WebFetch）。下文系统提示中出现的 pwsh、fs-local、str-replace-editor、web 等工具清单属于宿主应用 DSH，在本运行时中不存在——不要调用、不要模仿其格式；要跑 PowerShell / Python 一律通过 Bash。绝不把 <antml:...> 之类的调用标记写进回复正文。
`

/**
 * Matches any leaked pseudo tool-call markup; once seen, the whole text channel is cut
 * (a real native tool call never travels through text, so this is always a leak).
 */
const LEAK_TAG_RE = /<(?:antml:|\/?invoke\b|function_calls\b)/

/** app-server adapter: registered as provider `zcode-cli`. */
export class ZcodeAppServerAdapter extends LlmAdapter {
  /**
   * @param {AdapterDeps} deps Resolved options, attachment resolver, logger.
   */
  constructor({ options, resolveAttachments, logger }) {
    super()
    this.options = options
    this.resolveAttachments = resolveAttachments
    this.logger = logger
    this.client = new AppServerClient({ options, logger })
    /** DSH sessionId -> app-server session entry. */
    /** @type {Map<string, SessionEntry>} */
    this.sessions = new Map()
    /** DSH sessionId -> that session's most recent turn-settling promise (serialisation gate). */
    /** @type {Map<string, Promise<void>>} */
    this.turnLocks = new Map()
    /** Handles for in-flight streams: woken at once on process exit / dispose, not after the turn timeout. */
    /** @type {Set<StreamHandle>} */
    this.activeStreams = new Set()
    this.client.onExit = () => {
      if (this.sessions.size !== 0) {
        this.logger?.warn?.(`zcode: app-server process exited, dropping ${this.sessions.size} cached sessions`)
        this.sessions.clear()
      }
      for (const handle of this.activeStreams) {
        try {
          handle.onDeath()
        } catch {
          /* One stream's cleanup must not affect the others. */
        }
      }
    }
  }

  /**
   * Kill the app-server and wake every in-flight stream.
   *
   * @returns {void}
   */
  dispose() {
    this.client.dispose()
    for (const handle of this.activeStreams) {
      try {
        handle.onDeath()
      } catch {
        /* One stream's cleanup must not affect the others. */
      }
    }
    this.sessions.clear()
    this.turnLocks.clear()
  }

  /**
   * Make the app-server abandon the session's running turn (`session/stop` is a
   * notification with no response). Whenever this turn did not end normally (timeout,
   * abort, send failure, turn.failed) this must be sent, or the turn lock stays taken
   * and the next turn hits `A prompt is already running for this session` immediately.
   *
   * @param {SessionEntry | undefined} session Session to stop.
   * @param {string} reason Why the stop is being sent (for the log line).
   * @returns {void}
   */
  stopTurn(session, reason) {
    if (session?.sessionId === undefined) return
    try {
      this.client.notify('session/stop', { sessionId: session.sessionId })
      this.logger?.warn?.(`zcode: sent session/stop (${reason})`)
    } catch (/** @type {any} */ error) {
      this.logger?.warn?.(`zcode: session/stop failed (${reason}): ${error?.message ?? error}`)
    }
  }

  /**
   * Read the model catalogue the CLI reports for the signed-in account.
   *
   * The catalogue is not configuration: it is what the account can actually serve right
   * now, so it is read from a live `session/create` and cached per process. A configured
   * `cliModels` list wins over it (a user pinning a subset or a display name should not
   * be overruled by the CLI), but the capabilites still come from the CLI when it knows
   * the model.
   *
   * @returns {Promise<import('./zcode-runtime.js').CatalogEntry[]>} Catalogue entries.
   */
  readCatalog() {
    if (this.catalog !== undefined) return Promise.resolve(this.catalog)
    if (this.catalogRead !== undefined) return this.catalogRead
    this.catalogRead = (async () => {
      await this.client.ensureStarted()
      const options = this.options()
      const workspacePath = options.cliCwd !== '' ? options.cliCwd : os.homedir()
      const created = await this.client.request(
        'session/create',
        { workspace: { workspacePath, workspaceKey: 'dsh-zcode-plan-bridge:probe' } },
        options.appServerTimeoutMs,
      )
      const catalog = readModelCatalog(created)
      const sessionId = created?.session?.sessionId
      if (typeof sessionId === 'string' && sessionId !== '') {
        // A probe session is not reused for turns and would otherwise sit in the CLI's
        // session list forever.
        this.client.notify('session/close', { sessionId })
      }
      if (catalog.length === 0) {
        this.logger?.warn?.('zcode: the CLI reported no models (is the ZCode client signed in?)')
      }
      this.catalog = catalog
      return catalog
    })().finally(() => {
      this.catalogRead = undefined
    })
    return this.catalogRead
  }

  /**
   * The catalogue used to answer model queries: the CLI's own list, or the static
   * fallback when the CLI cannot be reached or reports nothing.
   *
   * @returns {Promise<import('./zcode-runtime.js').CatalogEntry[]>} Catalogue entries.
   */
  async effectiveCatalog() {
    /** @type {import('./zcode-runtime.js').CatalogEntry[]} */
    let catalog
    try {
      catalog = await this.readCatalog()
    } catch (/** @type {any} */ error) {
      if (this.options().accountMode === 'start-plan') throw error
      this.logger?.warn?.(`zcode: could not read the CLI model catalogue (${error?.message ?? error}); using the static fallback`)
      return /** @type {import('./zcode-runtime.js').CatalogEntry[]} */ ([...FALLBACK_CATALOG])
    }
    if (catalog.length === 0) {
      return /** @type {import('./zcode-runtime.js').CatalogEntry[]} */ ([...FALLBACK_CATALOG])
    }
    return catalog
  }

  /**
   * Advertised models: configuration pins win when set, otherwise the CLI catalogue.
   *
   * @returns {Promise<CliModel[]>} The effective model list.
   */
  async effectiveModels() {
    const options = this.options()
    if (options.cliModels.length !== 0) return options.cliModels
    const catalog = await this.effectiveCatalog()
    return collapseCatalog(catalog).map((entry) => ({
      id: entry.modelId,
      name: entry.label,
      description: entry.providerLabel === entry.label ? undefined : entry.providerLabel,
      contextWindow: entry.contextWindow ?? options.defaultContextWindow,
      maxTokens: entry.maxOutputTokens ?? options.maxTokens,
      inputModalities: /** @type {readonly import('@deepseek-ai/dsh-llm').ModelModality[]} */ (
        entry.supportsImage ? [...MODEL_MODALITIES] : ['text']),
      cliModelId: entry.modelId,
    }))
  }

  /**
   * Describe the provider route.
   *
   * @param {string} provider Provider route key.
   * @returns {LlmProviderInfo} Provider display metadata.
   */
  providerInfo(provider) {
    return { id: provider, name: 'ZCode CLI（客户端 agent）' }
  }

  /**
   * Provider-owned retry policy.
   *
   * @returns {ResolvedRetryPolicy} The configured retry policy.
   */
  providerRetryPolicy() {
    return this.options().retryPolicy
  }

  /**
   * List the models this route advertises.
   *
   * @param {string} provider Provider route key.
   * @returns {Promise<readonly LlmModelInfo[]>} Advertised models.
   */
  async listModels(provider) {
    const models = await this.effectiveModels()
    /** @type {LlmModelInfo[]} */
    const advertised = models.map((model) => ({
      provider,
      id: model.id,
      name: model.name,
      ...(model.description === undefined ? {} : { description: model.description }),
      inputModalities: [...model.inputModalities],
    }))
    return advertised
  }

  /**
   * Resolve one model's capacities.
   *
   * @param {string} provider Provider route key.
   * @param {string} model Model id.
   * @returns {Promise<LlmResolvedModelInfo>} Resolved model metadata.
   */
  async resolveModel(provider, model) {
    const options = this.options()
    const models = await this.effectiveModels()
    const configured = models.find((entry) => entry.id === model)
    const reasoning = await this.reasoningInfo(model)
    /** @type {LlmResolvedModelInfo} */
    const resolved = {
      provider,
      id: model,
      name: configured?.name ?? model,
      inputModalities: [...(configured?.inputModalities ?? MODEL_MODALITIES)],
      context: { contextWindow: configured?.contextWindow ?? options.defaultContextWindow },
      defaultMaxTokens: configured?.maxTokens ?? options.maxTokens,
      ...(reasoning === undefined ? {} : { reasoning }),
    }
    return resolved
  }

  /**
   * Reasoning efforts the CLI reports for a model, translated to DSH's shape.
   *
   * @param {string} model Model id.
   * @returns {Promise<import('@deepseek-ai/dsh-llm').LlmModelReasoningInfo | undefined>} Reasoning info.
   */
  async reasoningInfo(model) {
    /** @type {import('./zcode-runtime.js').CatalogEntry[]} */
    let catalog
    try {
      catalog = await this.effectiveCatalog()
    } catch {
      return undefined
    }
    const entry = pickCatalogEntry(catalog, model)
    if (entry === undefined || entry.reasoningLevels.length === 0) return undefined
    const levels = entry.reasoningLevels
    const preferred = entry.defaultReasoningLevel ?? DEFAULT_REASONING_LEVEL
    const defaultLevel = levels.includes(preferred) ? preferred : levels[0]
    return {
      efforts: levels.map((level) => ({ id: ReasoningEffortId(level), name: level })),
      defaultEffort: ReasoningEffortId(defaultLevel),
    }
  }

  /**
   * Resolve the CLI-side route that serves a DSH model id.
   *
   * DSH ids are the CLI's own model ids (or a pinned `cliModels` entry's `cliModelId`),
   * so the mapping is a catalogue lookup. When the catalogue cannot be read the model id
   * is passed through unchanged and the CLI's own default provider is left in place:
   * `session/setModel` is skipped entirely, because inventing a provider id is exactly
   * the bug this lookup exists to remove.
   *
   * @param {string} model DSH model id.
   * @returns {Promise<{ providerId: string, modelId: string, reasoningLevel: string } | undefined>} The route.
   */
  async resolveRoute(model) {
    const options = this.options()
    const pinned = options.cliModels.find((entry) => entry.id === model)
    const wanted = pinned?.cliModelId ?? model
    /** @type {import('./zcode-runtime.js').CatalogEntry[]} */
    let catalog
    try {
      catalog = await this.effectiveCatalog()
    } catch {
      return undefined
    }
    const entry = pickCatalogEntry(catalog, wanted)
    if (entry === undefined) {
      this.logger?.warn?.(`zcode: model "${model}" is not in the CLI catalogue; keeping the session's default model`)
      return undefined
    }
    const levels = entry.reasoningLevels
    const preferred = entry.defaultReasoningLevel ?? DEFAULT_REASONING_LEVEL
    return {
      providerId: entry.providerId,
      modelId: entry.modelId,
      reasoningLevel: levels.includes(preferred) ? preferred : (levels[0] ?? DEFAULT_REASONING_LEVEL),
    }
  }

  /**
   * Create (or reuse) an app-server session.
   *
   * @param {string} dshSessionKey DSH session key.
   * @param {string} model DSH model id the first turn targets.
   * @returns {Promise<SessionEntry>} The session entry.
   * @throws {LlmError} When the app-server returns no sessionId.
   */
  async ensureSession(dshSessionKey, model) {
    const existing = this.sessions.get(dshSessionKey)
    const options = this.options()
    if (existing !== undefined) {
      if (existing.authorizationPolicy !== options.authorizationPolicy) {
        await this.syncAuthorizationMode(existing.sessionId, options)
        existing.authorizationPolicy = options.authorizationPolicy
      }
      return existing
    }

    await this.client.ensureStarted()
    // Default the working directory to the user's home: the DSH process cwd may be a
    // huge tree, and the agent scans its workspace at start-up, so handing it tens of
    // thousands of files makes the turn hang.
    const workspacePath = options.cliCwd !== '' ? options.cliCwd : os.homedir()
    const created = await this.client.request(
      'session/create',
      { workspace: { workspacePath, workspaceKey: 'dsh-zcode-plan-bridge' } },
      options.appServerTimeoutMs,
    )
    const sessionId = created?.session?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new LlmError('app-server 没有返回 sessionId', 'PROVIDER')
    }
    // The creation response also carries the account's catalogue; keep it so later turns
    // and the model list do not need another probe session.
    const reported = readModelCatalog(created)
    if (reported.length !== 0) this.client.catalog = reported
    const current = readCurrentModel(created)
    await this.client.request(
      'session/subscribe',
      { sessionId, deliveryKind: 'desktop-continuous', afterSeq: 0, includeSnapshot: true },
      options.appServerTimeoutMs,
    )
    await this.syncAuthorizationMode(sessionId, options)
    // The CLI owns the account, so no injection happens here; the only thing left is to
    // point the session at the model DSH asked for. A new session already defaults to the
    // account's own selection, so this is skipped when it is already right.
    const route = await this.resolveRoute(model)
    /** @type {{ providerId: string, modelId: string }} */
    let selected = current ?? { providerId: '', modelId: '' }
    if (route !== undefined && (current === undefined || current.providerId !== route.providerId || current.modelId !== route.modelId)) {
      try {
        // The CLI requires the object form of `model`, with `reasoningLevel` mandatory.
        await this.client.request(
          'session/setModel',
          {
            sessionId,
            model: {
              providerId: route.providerId,
              modelId: route.modelId,
              options: { reasoningLevel: route.reasoningLevel },
            },
          },
          options.appServerTimeoutMs,
        )
        selected = { providerId: route.providerId, modelId: route.modelId }
        this.logger?.info?.(`zcode: session model switched to ${route.providerId}/${route.modelId}`)
      } catch (/** @type {any} */ error) {
        this.logger?.warn?.(`zcode: setModel failed (keeping the session default model): ${error?.message ?? error}`)
      }
    }
    // Measured timing: 1.5s each between create->subscribe and subscribe->send. With
    // zero delay the turn is dropped silently (send accepted, then an empty event
    // stream), reproduced many times.
    await sleep(1500)
    /** @type {SessionEntry} */
    const entry = {
      sessionId,
      firstTurn: true,
      providerId: selected.providerId,
      modelId: selected.modelId,
      authorizationPolicy: options.authorizationPolicy,
    }
    this.sessions.set(dshSessionKey, entry)
    this.logger?.info?.(`zcode: new app-server session ${sessionId}`)
    return entry
  }

  /**
   * Synchronize the ZCode session permission mode with the configured policy.
   * Both policies keep the app-server in build mode, where permission requests reach
   * this bridge. A failed mode switch aborts the turn under either policy.
   *
   * @param {string} sessionId ZCode app-server session id.
   * @param {ResolvedOptions} options Current resolved plugin options.
   * @returns {Promise<void>}
   */
  async syncAuthorizationMode(sessionId, options) {
    const mode = modeForPolicy(options.authorizationPolicy)
    try {
      await this.client.request(
        'session/setMode',
        { sessionId, mode },
        options.appServerTimeoutMs,
      )
      this.logger?.info?.(`zcode: session permission mode set to ${mode}`)
    } catch (/** @type {any} */ error) {
      this.logger?.warn?.(`zcode: setMode to ${mode} failed; refusing to run without a confirmed permission mode: ${error?.message ?? error}`)
      throw new LlmError(
        `无法确认 ZCode 会话处于受限权限模式，已停止本轮：${error?.message ?? error}`,
        'PROVIDER',
      )
    }
  }

  /**
   * Run one turn as a streaming iterable.
   *
   * @param {GenerateOptions} options Assembled model request.
   * @returns {AsyncGenerator<StreamChunk, void, unknown>} Stream chunks.
   */
  async *stream(options) {
    const config = this.options()

    if (options.purpose === 'session-title') {
      const title = (lastUserText(options.messages, undefined) || '新会话').replace(/\s+/g, ' ').slice(0, 24)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: title }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: title } }
      yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    const key = String(options.sessionId ?? 'default')
    if (this.client.disposed === true) {
      throw new LlmError('app-server 已销毁（插件被停用或正在重启），请重试', 'TRANSPORT')
    }

    // Turn serialisation gate: an app-server session allows only one in-flight prompt,
    // and a concurrent second one is refused outright ("A prompt is already running for
    // this session"). Turns of the same DSH session therefore queue.
    const previousTurn = this.turnLocks.get(key) ?? Promise.resolve()
    /** @type {() => void} */
    let releaseTurn = () => {}
    const turnDone = new Promise((/** @type {(value?: void) => void} */ resolve) => {
      releaseTurn = resolve
    })
    const tail = previousTurn.then(() => turnDone)
    this.turnLocks.set(key, tail)
    tail.catch(() => {}).then(() => {
      if (this.turnLocks.get(key) === tail) this.turnLocks.delete(key)
    })
    // A previous generator that was abandoned (its consumer never reached `finally`)
    // must not queue forever: release at the cap and let stuck-turn recovery handle a
    // genuinely stuck lock.
    await settleWithin(previousTurn, TURN_QUEUE_MAX_MS)

    // Event queue: session/event -> stream chunks.
    /** @type {QueueItem[]} */
    const queue = []
    /** @type {() => void} */
    let notify = () => {}
    /** @returns {Promise<void>} */
    const waitFor = () => new Promise((/** @type {(value?: void) => void} */ resolve) => {
      notify = () => resolve()
    })
    /** @type {TurnResult | undefined} */
    let finished = undefined
    /** @type {TurnChannel | undefined} */
    let channel
    /** @type {import('@deepseek-ai/dsh-llm').TokenUsage} */
    let usage = { inputTokens: 0, outputTokens: 0 }
    let sawText = false
    /** @type {() => void} */
    let off = () => {}
    /** @type {MaterializedImages} */
    let imageCtx = { files: [], tempFiles: [], imageText: new Map() }
    /** @type {string[]} Images written this turn (stuck-turn recovery may recompute imageCtx, so delete them all here). */
    const tempFiles = []
    let turnSettled = false

    /** @type {SessionEntry | undefined} */
    let session = undefined
    try {
      session = await this.ensureSession(key, options.model)
    } catch (error) {
      releaseTurn()
      throw error
    }
    // Fork detection: after a DSH-side edit or rewind, a resumed turn would splice the
    // new branch into the old app-server session (whose context still holds the old
    // branch, so the model answers the new question while looking at old history). When
    // the message prefix at the previous send no longer matches, the history changed --
    // rebuild the session and replay the whole (new) conversation as a first turn.
    if (session.firstTurn === false) {
      const sentLength = session.sentLength ?? 0
      const prefixFingerprint = conversationFingerprint((options.messages ?? []).slice(0, sentLength), options.system)
      if (sentLength === 0 || prefixFingerprint !== session.sentFingerprint) {
        this.logger?.warn?.('zcode: DSH session history changed (edit / rewind) -> rebuilding the app-server session and replaying the whole conversation')
        this.sessions.delete(key)
        try {
          session = await this.ensureSession(key, options.model)
        } catch (error) {
          releaseTurn()
          throw error
        }
      } else {
        // The same session moved to another model: reselect it on the existing session.
        const route = await this.resolveRoute(options.model)
        if (route !== undefined && (route.providerId !== session.providerId || route.modelId !== session.modelId)) {
          try {
            await this.client.request(
              'session/setModel',
              {
                sessionId: session.sessionId,
                model: {
                  providerId: route.providerId,
                  modelId: route.modelId,
                  options: { reasoningLevel: route.reasoningLevel },
                },
              },
              config.appServerTimeoutMs,
            )
            session.providerId = route.providerId
            session.modelId = route.modelId
            this.logger?.info?.(`zcode: session model switched to ${route.providerId}/${route.modelId}`)
          } catch (/** @type {any} */ error) {
            this.logger?.warn?.(`zcode: setModel failed (keeping the session's current model): ${error?.message ?? error}`)
          }
        }
      }
    }

    off = this.client.onNotification((message) => {
      if (message.method !== 'session/event') return
      const params = message.params ?? {}
      // The session is replaced during stuck-turn recovery: only accept the current one.
      if (session === undefined || params.sessionId !== session.sessionId) return
      const { type, payload } = eventPayload(message)
      switch (type) {
        case 'session.updated':
          if (typeof payload.baseURL === 'string') {
            channel = { providerId: payload.providerId, modelId: payload.modelId, baseURL: payload.baseURL }
            this.client.lastChannel = channel
          }
          break
        case 'model.streaming': {
          if (payload.done === true) break
          if (payload.kind === 'text_delta') {
            sawText = true
            queue.push({ kind: 'text', text: String(payload.delta ?? '') })
          } else if (payload.kind === 'reasoning_delta') {
            queue.push({ kind: 'reasoning', text: String(payload.delta ?? '') })
          }
          notify()
          break
        }
        case 'turn.completed': {
          if (payload.usage !== undefined) {
            usage = {
              inputTokens: payload.usage.inputTokens ?? 0,
              outputTokens: payload.usage.outputTokens ?? 0,
              ...(payload.usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: payload.usage.cacheReadTokens }),
            }
          }
          finished = {
            response: typeof payload.response === 'string' ? payload.response : '',
            resultType: payload.resultType ?? 'success',
            error: undefined,
          }
          notify()
          break
        }
        case 'turn.failed': {
          // Unhandled, the turn would hang until the timeout; surface the upstream error
          // (402 out of credit, 401 auth failure, ...).
          const attribution = payload.error?.attribution ?? {}
          const detail = payload.error?.message ?? payload.error?.code ?? 'unknown'
          this.logger?.warn?.(
            `zcode: turn failed (${attribution.providerId ?? '?'}/${attribution.modelId ?? '?'} ${attribution.providerErrorCode ?? ''} ${detail})`,
          )
          finished = { response: '', resultType: 'failed', error: String(detail) }
          notify()
          break
        }
        default:
          break
      }
    })

    // Settle an in-flight stream at once when the process exits or the plugin disposes:
    // it must not sit until the turn timeout.
    /** @type {StreamHandle} */
    const streamHandle = {
      onDeath: () => {
        if (finished !== undefined) return
        finished = { response: '', resultType: 'failed', error: 'app-server 进程已退出，回合中止（下次调用自动重建会话）' }
        notify()
      },
    }
    this.activeStreams.add(streamHandle)

    // Image blocks become local files; the content names their paths and the agent reads
    // them with Read (the CLI turns that into vision input). Measured: neither a data-URL
    // embedded in content nor session/send's attachments parameter (ref = local path)
    // works -- the former makes the agent's Read fail on a file reference, the latter's
    // ref cannot be resolved server-side. Temp files outlive the send because the agent
    // reads them asynchronously during the turn; cleanup hangs off the generator's finally.
    const attachmentsService = typeof this.resolveAttachments === 'function' ? this.resolveAttachments() : undefined
    /**
     * Materialise images for the range a session needs: a first turn takes the whole
     * history, a resumed one only the last user message.
     *
     * @param {boolean} fullHistory Whether to materialise the whole conversation.
     * @returns {Promise<MaterializedImages>} Placeholders and files.
     */
    const attachImages = async (fullHistory) => {
      const source = fullHistory
        ? options.messages
        : (options.messages ?? []).filter((message) => message?.role === 'user').slice(-1)
      const ctx = await materializeImages(source, { attachments: attachmentsService, logger: this.logger })
      tempFiles.push(...ctx.tempFiles)
      return ctx
    }
    try {
      imageCtx = await attachImages(session.firstTurn)
    } catch (error) {
      off()
      releaseTurn()
      throw error
    }

    /**
     * Build this turn's content: a first turn replays the whole conversation, a resumed
     * session sends only the last user message.
     *
     * @param {SessionEntry} entry Session entry.
     * @param {MaterializedImages} ctx Materialised images.
     * @returns {string} Content to send.
     */
    const buildContent = (entry, ctx) => {
      const base = entry.firstTurn
        ? flattenConversation(options.messages, options.system, ctx.imageText) || lastUserText(options.messages, ctx.imageText)
        : lastUserText(options.messages, ctx.imageText)
      // The bridge note rides along with the first turn's whole history (once at each
      // end); resumed turns rely on that copy already sitting in the session history.
      const text = entry.firstTurn ? TOOL_RULE_HEAD + '\n' + base + BRIDGE_NOTE : base
      if (ctx.files.length === 0) return text || '（继续）'
      const listing = ctx.files.map((file, i) => `#${i + 1} ${file}`).join('\n')
      return `${text || '（继续）'}\n\n[图片附件] 本条消息附有 ${ctx.files.length} 张本地图片（对应上文 [图片 #k] 占位）：\n${listing}\n回答前请先用 Read 工具逐张读取这些图片。`
    }
    if (imageCtx.files.length > 0) this.logger?.info?.(`zcode: ${imageCtx.files.length} image attachment(s) sent with the message`)
    if (session.firstTurn) await sleep(1500) // Measured timing shim (see ensureSession).

    try {
      // Send with stuck-turn recovery: the app-server's turn lock is not released by
      // itself when the previous turn was aborted or timed out, so resending hits
      // "A prompt is already running for this session". Send stop and retry once; if
      // that fails too (or the app-server reclaimed the session), switch to a new
      // session -- a new session has firstTurn=true and replays the whole conversation.
      let sendResult
      for (let attempt = 0; ; attempt += 1) {
        try {
          sendResult = await this.client.request(
            'session/send',
            { sessionId: session.sessionId, content: buildContent(session, imageCtx) },
            config.appServerTimeoutMs,
          )
          session.firstTurn = false // Only a real send makes it a resumed session; keep firstTurn on failure so it can replay.
          // Record the message-list fingerprint at this send: the next resumed turn uses
          // it as a prefix check to detect DSH-side history edits and rewinds.
          session.sentLength = (options.messages ?? []).length
          session.sentFingerprint = conversationFingerprint(options.messages, options.system)
          this.logger?.info?.(`zcode: session/send -> ${JSON.stringify(sendResult).slice(0, 200)}`)
          break
        } catch (/** @type {any} */ error) {
          const detail = String(error?.message ?? error)
          const stuck = STUCK_TURN_ERROR.test(detail)
          const stale = !stuck && STALE_SESSION_ERROR.test(detail)
          if (attempt >= 1 || (!stuck && !stale)) throw error
          if (stuck) {
            this.logger?.warn?.(`zcode: session ${session.sessionId} previous turn not released (${detail}) -> sending session/stop and retrying`)
            this.stopTurn(session, '上一轮未释放')
            await sleep(STOP_SETTLE_MS)
          } else {
            this.logger?.warn?.(`zcode: session ${session.sessionId} is gone (${detail}) -> rebuilding the session and replaying the whole conversation`)
            this.sessions.delete(key)
            session = await this.ensureSession(key, options.model)
            imageCtx = await attachImages(true)
          }
        }
      }

      let started = false
      // Cut the text channel as soon as pseudo antml/invoke markup appears: a real
      // native tool call never travels through text, so anything here is a leak, and
      // forwarding it would leave tag garbage in the DSH chat window.
      let suppressed = false
      let tail = ''
      /**
       * Emit one text fragment, unless the text channel has been cut.
       *
       * @param {string} raw Fragment to emit.
       * @returns {Generator<StreamChunk, void, unknown>} Chunks to yield.
       */
      const emitText = function* (raw) {
        if (suppressed) return
        if (LEAK_TAG_RE.test(raw) || LEAK_TAG_RE.test((tail + raw).slice(-64))) {
          suppressed = true
          return
        }
        tail = (tail + raw).slice(-24)
        if (!started) {
          started = true
          yield { type: 'block-start', index: 1, blockType: 'text' }
        }
        yield { type: 'text-delta', index: 1, text: raw }
      }
      const deadline = Date.now() + config.zcodeCliTimeoutMs
      while (finished === undefined) {
        while (queue.length > 0) {
          const item = /** @type {QueueItem} */ (queue.shift())
          if (item.kind === 'text') {
            yield* emitText(item.text)
          } else {
            // Reasoning passes through the same sanitiser: a complete pseudo-call block
            // collapses into a placeholder so no tag garbage reaches DSH's thinking block.
            yield { type: 'reasoning-delta', index: 0, text: sanitizeLeakedCalls(item.text) }
          }
        }
        if (finished !== undefined) break
        if (Date.now() > deadline) throw new LlmError(`app-server 回合超时（${config.zcodeCliTimeoutMs}ms）`, 'TIMEOUT')
        // stop is sent from finally for every path that leaves the wait loop early, so
        // the app-server's turn lock is always released.
        if (options.signal?.aborted === true) throw new LlmError('请求被调用方中止', 'ABORTED')
        await Promise.race([waitFor(), sleep(500)])
      }
      // Only turn.completed ends a turn normally; turn.failed also gets a stop for safety.
      turnSettled = /** @type {TurnResult} */ (finished).resultType === 'success'

      // Drain the remaining queue.
      while (queue.length > 0) {
        const item = /** @type {QueueItem} */ (queue.shift())
        if (item.kind === 'text') {
          yield* emitText(item.text)
        } else {
          yield { type: 'reasoning-delta', index: 0, text: item.text }
        }
      }

      const resolved = /** @type {TurnResult} */ (finished)
      if (suppressed) {
        if (!started) {
          started = true
          yield { type: 'block-start', index: 1, blockType: 'text' }
        }
        yield {
          type: 'text-delta',
          index: 1,
          text: '\n\n〔拦截说明：模型试图把工具调用写成正文（伪 antml 标记），这段输出已被桥接层拦下。本通道的工具由 agent 原生执行、不会以文本形式出现；若反复出现此提示，请重发消息或新开会话。〕',
        }
      }

      const finalText = sanitizeLeakedCalls(resolved.response !== '' ? resolved.response : '')
      if (started) {
        yield { type: 'block-end', index: 1, block: { type: 'text', text: finalText } }
      }
      // Re-annotate: the value is assigned from inside the notification callback, so the
      // control-flow narrowing of the declaration above no longer applies here.
      const observedChannel = /** @type {TurnChannel | undefined} */ (channel)
      if (observedChannel !== undefined) {
        this.logger?.info?.(
          `zcode: this turn ran on providerId=${String(observedChannel.providerId ?? '?')} model=${String(observedChannel.modelId ?? '?')} baseURL=${String(observedChannel.baseURL ?? '?')}`,
        )
      }
      yield { type: 'usage', usage }
      if ((resolved.resultType !== 'success' && finalText === '') || resolved.error !== undefined) {
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              message: resolved.error !== undefined
                ? `ZCode Start Plan 回合失败：${resolved.error}`
                : `app-server 回合以 ${resolved.resultType} 结束`,
              // These are transient provider capacity errors. Let DSH's bounded,
              // cancellable retry policy wait for a slot instead of ending the turn.
              code: /\b(?:user|model)\s+concurrency\s+limit\s+exceeded\b/i.test(resolved.error ?? '')
                ? 'RATE_LIMIT'
                : 'PROVIDER',
            },
          },
        }
        return
      }
      yield {
        type: 'finish',
        reason: { kind: 'stop' },
        replayState: {
          response: { model: options.model, stopReason: 'end_turn' },
          blocks: [null, null],
          ...(observedChannel === undefined ? {} : { channel: observedChannel }),
        },
      }
    } finally {
      this.activeStreams.delete(streamHandle)
      off()
      if (!turnSettled) this.stopTurn(session, '本轮未正常结束（超时 / 中止 / 发送失败 / 回合失败）')
      removeFiles(tempFiles) // Delete only after the turn (the agent reads images during it).
      releaseTurn()          // Let the next queued turn of this DSH session proceed.
    }
  }
}
