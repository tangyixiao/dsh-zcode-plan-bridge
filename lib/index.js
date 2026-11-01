/**
 * dsh-zcode-plan-bridge — exposes the ZCode CLI's account-backed coding agent inside
 * DeepSeek Harness as a model provider.
 *
 * The plugin registers one provider route, `zcode-cli`, backed by the resident
 * app-server session the ZCode client itself uses (JSON-RPC over stdio, real streaming).
 * The CLI owns the account: when it answers `session/create` it also reports the
 * catalogue the signed-in account can actually serve, and the bridge republishes that
 * catalogue. Model ids, context capacity, output caps, image support and reasoning
 * levels therefore come from the running CLI rather than from constants here — a
 * hard-coded list would silently disagree with the account it claims to describe.
 *
 * History: this plugin began as a DSH integration for zcode2api (HTTP gateway plus
 * account pool). The gateway and the one-shot CLI route were removed on 2026-09-30;
 * use the upstream https://github.com/liu5269/zcode2api if you need them.
 *
 * The only dependencies are peer packages shipped with the harness; there are no
 * third-party runtime dependencies.
 *
 * @module dsh-zcode-plan-bridge
 */

import { fileURLToPath } from 'node:url'

import z from '@deepseek-ai/schemastery'
import { RetryPolicySchema, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'

import { ZcodeAppServerAdapter } from './app-server.js'
import { resolveCommunityRetry } from './community-retry.js'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  FALLBACK_CATALOG,
  MODEL_MODALITIES,
  locateZcodeCli,
} from './zcode-runtime.js'

/** Package name; must equal the `name` in package.json and the bundle patch row name. */
export const name = 'dsh-zcode-plan-bridge'

/** `llm` carries model-provider registration. */
export const inject = ['llm']

/** Plugin package directory (the parent of lib/). */
export const pluginDir = fileURLToPath(new URL('..', import.meta.url))

// ── configuration ─────────────────────────────────────────────────────────────

/**
 * One model the provider advertises, as the plugin resolves it.
 *
 * Configuration may pin entries; when it does not, the list is whatever the CLI reports
 * for the signed-in account.
 *
 * @typedef {object} CliModel
 * @property {string} id Model id exposed to DSH.
 * @property {string} name Display name.
 * @property {string | undefined} description Optional description.
 * @property {number} contextWindow Context window in tokens.
 * @property {number} maxTokens Maximum output tokens.
 * @property {readonly import('@deepseek-ai/dsh-llm').ModelModality[]} inputModalities Accepted input modalities.
 * @property {string} cliModelId Model id on the CLI side (the route this entry resolves to).
 */

/**
 * @typedef {object} ResolvedOptions
 * @property {boolean} enabled Whether the provider is registered.
 * @property {string} zcodeCliPath Resolved zcode.cjs path ('' when not found).
 * @property {string} zcodeCliNode Node executable used to run zcode.cjs.
 * @property {'standalone' | 'start-plan'} accountMode Account subscription used by the CLI.
 * @property {number} zcodeCliTimeoutMs Per-turn timeout in milliseconds.
 * @property {CliModel[]} cliModels Pinned models; empty means "whatever the CLI reports".
 * @property {string} cliCwd Working directory for the app-server session ('' = home).
 * @property {string} zcodeDataBaseDir ZCode data root ('' = home).
 * @property {string[]} childEnvAllow Extra environment variables passed to the child.
 * @property {number} appServerTimeoutMs Per-request timeout in milliseconds.
 * @property {'deny' | 'allow-all'} authorizationPolicy How app-server permission requests are handled.
 * @property {number} maxTokens Default max_tokens.
 * @property {number} defaultContextWindow Default context window.
 * @property {import('@deepseek-ai/dsh-llm').ResolvedRetryPolicy} retryPolicy Resolved retry policy.
 * @property {import('./community-retry.js').CommunityRetryOptions} communityRetry Independent community retry layer.
 */

/** @type {readonly import('@deepseek-ai/dsh-llm').ModelModality[]} */
const MODALITIES = /** @type {readonly import('@deepseek-ai/dsh-llm').ModelModality[]} */ ([...MODEL_MODALITIES])

/**
 * Models to advertise when neither the CLI nor configuration supplies a list.
 *
 * This is a last resort, not the catalogue: it exists so a misconfigured or logged-out
 * installation shows *something* actionable instead of an empty provider. `cliModels`
 * overrides it, and a working CLI always wins over both.
 *
 * @type {readonly CliModel[]}
 */
export const FALLBACK_CLI_MODELS = FALLBACK_CATALOG.map((entry) => ({
  id: entry.modelId,
  name: entry.label,
  description: entry.providerLabel,
  contextWindow: entry.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
  maxTokens: entry.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
  inputModalities: entry.supportsImage ? MODALITIES : /** @type {const} */ (['text']),
  cliModelId: entry.modelId,
}))

const catalogModel = z.object({
  id: z.string().required().description('Model id exposed to DSH (must be unique)'),
  name: z.string().description('Display name; default = the id'),
  description: z.string().description('Display description'),
  contextWindow: z.number().step(1).min(1).description('Context window; default = what the CLI reports'),
  maxTokens: z.number().step(1).min(1).description('Maximum output tokens; default = what the CLI reports'),
  inputModalities: z.array(z.union(MODEL_MODALITIES)).min(1)
    .description("Accepted input modalities; default = the CLI's own capability flags"),
  cliModelId: z.string()
    .description('CLI-side model id this entry resolves to; default = the DSH id'),
})

export const Config = z.object({
  enabled: z.boolean().default(true).description('Master switch: when off, no model provider is registered'),
  zcodeCliPath: z.string().default('')
    .description('Path to zcode.cjs; empty = auto-detect the ZCode client or an npm-installed zcode-app-cli'),
  zcodeCliNode: z.string().default('node').description('Node executable used to run zcode.cjs'),
  accountMode: z.union(['standalone', 'start-plan']).default('standalone')
    .description('Use start-plan for the ZCode desktop Start Plan subscription; standalone follows CLI Coding Plan accounts'),
  zcodeCliTimeoutMs: z.number().step(1).min(5000).default(900000)
    .description('Timeout for one app-server turn (session/send until the turn completes), in milliseconds'),
  cliModels: z.array(catalogModel).default([])
    .description('Pin the advertised model list. Empty (the default) follows the catalogue the CLI reports for the signed-in account'),
  cliCwd: z.string().default('').description('Working directory of the app-server session; empty = user home'),
  zcodeDataBaseDir: z.string().default('')
    .description('ZCode data root (credentials and runtime releases); empty = user home (~/.zcode/v2)'),
  childEnvAllow: z.array(z.string()).default([])
    .description('Extra environment variable names passed through to the app-server child; by default only system basics, ZCODE_* and NODE_EXTRA_CA_CERTS are forwarded'),
  authorizationPolicy: z.union(['deny', 'allow-all']).default('deny')
    .description('Deny agent permission requests by default. Set to allow-all only if you accept unattended tool execution.'),
  appServerTimeoutMs: z.number().step(1).min(5000).default(120000)
    .description('Timeout for a single app-server request (create/subscribe/send), in milliseconds'),
  maxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS)
    .description('Default maximum output tokens when the CLI reports none'),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW)
    .description('Default context window when the CLI reports none'),
  retryPolicy: RetryPolicySchema,
  communityRetry: z.object({
    enabled: z.boolean().default(false).description('启用非官方社区自动重试；关闭原生与 DSH 外层重试，下次创建子进程生效'),
    mode: z.union(['unlimited', 'bounded']).default('unlimited').description('unlimited 无限重试；bounded 使用次数和累计时间限制'),
    intervalMs: z.number().step(1).min(0).max(86400000).default(5000).description('无限模式固定重试间隔（毫秒）；10000 = 10 秒'),
    maxRetries: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER - 1).default(6).description('仅有限模式：额外重试次数，可设置很大数值'),
    baseDelayMs: z.number().step(1).min(0).max(300000).default(5000),
    maxDelayMs: z.number().step(1).min(0).max(300000).default(60000),
    backoffFactor: z.number().step(1).min(1).max(10).default(2),
    jitter: z.boolean().default(true),
    budgetMs: z.number().step(1).min(1).max(3600000).default(600000).description('仅有限模式：累计恢复时限（毫秒）；无限模式忽略'),
    probeTimeoutMs: z.number().step(1).min(1).max(300000).default(30000),
    maxBodyBytes: z.number().step(1).min(1).max(16777216).default(16777216),
    maxProbeBytes: z.number().step(1).min(1).max(262144).default(262144),
    allowedOrigins: z.array(z.string()).default(['https://zcode.z.ai', 'https://api.z.ai', 'https://open.bigmodel.cn']),
    dataDirectory: z.string().default('').description('社区重试诊断目录；空值使用桥接专用目录'),
  }),
})

/**
 * Validate and normalise configured model pins.
 *
 * Every optional field is materialised here so downstream code never has to re-apply
 * defaults, and duplicate ids are rejected because DSH keys models by id.
 *
 * @param {readonly Partial<CliModel>[] | undefined} models Raw catalog from configuration.
 * @returns {CliModel[]} Normalised pins; empty when configuration pins nothing.
 */
function resolveModels(models) {
  if (!Array.isArray(models)) return []
  /** @type {Set<string>} */
  const seen = new Set()
  return models.map((model) => {
    const id = (model.id ?? '').trim()
    if (id === '') throw new Error('zcode: model id must not be empty')
    if (seen.has(id)) throw new Error(`zcode: model "${id}" is duplicated`)
    seen.add(id)
    const name = (model.name ?? '').trim() || id
    const inputModalities = model.inputModalities ?? MODEL_MODALITIES
    if (inputModalities.length === 0) throw new Error(`zcode: model "${id}" has no inputModalities`)
    return {
      id,
      name,
      description: model.description,
      contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS,
      inputModalities: [...inputModalities],
      cliModelId: (model.cliModelId ?? '').trim() || id,
    }
  })
}

/**
 * Resolve the configuration into a read-only runtime snapshot; invalid values throw.
 *
 * @param {any} config Raw plugin configuration.
 * @returns {ResolvedOptions} Resolved options.
 */
export function resolveOptions(config) {
  if (config.defaultContextWindow !== undefined && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) {
    throw new Error('zcode: defaultContextWindow must be a positive integer')
  }
  if (config.maxTokens !== undefined && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) {
    throw new Error('zcode: maxTokens must be a positive integer')
  }
  const zcodeCliTimeoutMs = config.zcodeCliTimeoutMs ?? 900000
  if (!Number.isSafeInteger(zcodeCliTimeoutMs) || zcodeCliTimeoutMs < 5000) {
    throw new Error('zcode: zcodeCliTimeoutMs must be an integer not smaller than 5000')
  }

  return {
    enabled: config.enabled !== false,
    zcodeCliPath: locateZcodeCli(config.zcodeCliPath),
    zcodeCliNode: (config.zcodeCliNode ?? 'node').trim() || 'node',
    accountMode: config.accountMode === 'start-plan' ? 'start-plan' : 'standalone',
    zcodeCliTimeoutMs,
    cliModels: resolveModels(config.cliModels),
    cliCwd: (config.cliCwd ?? '').trim(),
    zcodeDataBaseDir: (config.zcodeDataBaseDir ?? '').trim(),
    childEnvAllow: Array.isArray(config.childEnvAllow)
      ? config.childEnvAllow.filter(/** @type {(key: unknown) => boolean} */ ((key) => typeof key === 'string' && key.trim() !== ''))
      : [],
    authorizationPolicy: config.authorizationPolicy === 'allow-all' ? 'allow-all' : 'deny',
    appServerTimeoutMs: config.appServerTimeoutMs ?? 120000,
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'zcode: retryPolicy'),
    communityRetry: resolveCommunityRetry(config.communityRetry),
  }
}

// ── apply ─────────────────────────────────────────────────────────────────────

/**
 * Plugin entry point: register provider `zcode-cli` and its app-server adapter.
 *
 * @param {any} ctx Cordis context (the `llm` service is injected).
 * @param {any} config Raw plugin configuration.
 * @returns {void}
 */
export function apply(ctx, config) {
  const logger = ctx.logger ?? console

  // Configuration hot-reload: one invalid edit must not take down a running plugin,
  // so keep the last usable configuration.
  /** @type {(() => any)} */
  let current = () => config
  /** @type {any} */
  let lastRaw
  /** @type {ResolvedOptions | undefined} */
  let lastGood
  /**
   * @returns {ResolvedOptions}
   */
  const options = () => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveOptions(raw)
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      if (lastGood === undefined) throw error
      lastRaw = raw
      logger.error?.('zcode: invalid configuration, keeping the last usable one')
      logger.error?.(error)
      return lastGood
    }
  }
  options()

  const initial = options()
  const adapter = new ZcodeAppServerAdapter({
    options,
    resolveAttachments: () => (typeof ctx.get === 'function' ? ctx.get('attachments') : undefined),
    logger,
  })

  const entryNs = ctx.fiber?.entry?.options?.id ?? name

  ctx.effect(() => () => {
    if (typeof adapter.dispose === 'function') adapter.dispose()
  }, 'zcode-cli: app-server client')

  if (initial.enabled) {
    if (initial.zcodeCliPath !== '') {
      ctx.llm.registerConfigurableProviders([{
        provider: 'zcode-cli',
        displayName: 'ZCode CLI (account bridge)',
        settingsNs: entryNs,
        settingsPath: [],
      }])
      ctx.llm.registerAdapter(['zcode-cli'], adapter)
      const pinned = initial.cliModels.length === 0
        ? 'follow the CLI catalogue'
        : `pinned=${initial.cliModels.map((model) => model.id).join('/')}`
      logger.info?.(`zcode: provider "zcode-cli" registered (app-server account route), models=${pinned}`)
    } else {
      logger.warn?.('zcode: no ZCode CLI found, provider "zcode-cli" not registered (set the zcodeCliPath option)')
    }
  }

  logger.info?.('zcode: loaded, provider="zcode-cli" (ZCode CLI account bridge)')
}

export { ZcodeAppServerAdapter }
export default { name, inject, Config, apply }
