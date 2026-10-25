/**
 * ZCode CLI discovery, model-catalogue normalisation and builtin inspection.
 *
 * Everything here uses Node built-ins only: `lib/diagnostics.js` (and the CLI in
 * `bin/`) reuse these helpers to inspect an installation *without* loading
 * `@deepseek-ai/dsh-llm`, so `doctor` still works when the plugin itself fails to
 * load against an incompatible host.
 *
 * Design note -- the CLI owns the model list. `session/create` answers with
 * `settings.model.available`, the account's authoritative catalogue, and the CLI
 * manages that account itself (it is a standalone process: it refuses
 * `provider/updateAccountConfig` with "Standalone Account 由本进程管理"). Earlier
 * versions of this bridge hard-coded a Start Plan provider id and injected an
 * entitlement patch; that provider does not exist on the npm CLI and the injection is
 * refused, so the catalogue reported here is the single source of truth.
 *
 * @module lib/zcode-runtime
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Resolve Start Plan membership from the billing service, preserving the CLI's
 * model spelling. A Coding Plan login is not proof of Start Plan entitlement.
 * @param {any} payload Billing/current response.
 * @param {string[]} builtinIds Models understood by this installed kernel.
 * @returns {string[]} Models granted by currently active plans.
 */
export function startPlanModelIds(payload, builtinIds) {
  if (payload?.code !== 0) throw new Error('Start Plan entitlement request failed')
  const now = payload.data?.server_time ?? Date.now() / 1000
  const known = new Map()
  for (const id of builtinIds) {
    if (!known.has(id.toLowerCase())) known.set(id.toLowerCase(), id)
  }
  const found = new Set()
  for (const plan of payload.data?.plans ?? []) {
    if (plan.status !== 'active' || (plan.starts_at != null && plan.starts_at > now)
      || (plan.ends_at != null && plan.ends_at <= now)) continue
    for (const grant of plan.entitlements ?? []) {
      if (grant.effective_at != null && grant.effective_at > now) continue
      for (const capability of grant.capabilities ?? []) {
        if (typeof capability !== 'string' || !capability.startsWith('model:')) continue
        const id = known.get(capability.slice(6).toLowerCase())
        if (id !== undefined) found.add(id)
      }
    }
  }
  if (found.size === 0) throw new Error('No active Start Plan model entitlements')
  return [...found]
}

/**
 * Build the native Host account snapshot. The kernel hashes the resolved file
 * path for its source identity; using a content hash silently disables models.
 * @param {{revision?: number, activeFilePath: string}} builtin Kernel release.
 * @param {string[]} models Server-granted model ids.
 * @returns {any} provider/updateAccountConfig parameters.
 */
export function startPlanAccountConfig(builtin, models) {
  const source = createHash('sha256').update(path.resolve(builtin.activeFilePath)).digest('hex')
  const basedOnZCodeBuiltinRevision = `zcode-builtin:${builtin.revision}:${source}`
  return {
    revision: `dsh-start-plan:${basedOnZCodeBuiltinRevision}:${models.join(',')}`,
    basedOnZCodeBuiltinRevision,
    providers: { 'account:zai-start-plan': {
      access: { type: 'zhipu-account', entitled: true }, builtinModelIds: models,
    } },
    states: { 'account:zai-start-plan': { availability: 'available', entitled: true, current: true } },
  }
}

/**
 * Candidate locations of the CLI (zcode.cjs).
 *
 * Why the ZCode CLI at all: the plan endpoint sits behind an Alibaba Cloud
 * invisible-verification challenge, so external HTTP callers -- real browsers and the
 * client renderer included -- are rejected with 3007/3012. The CLI carries its own
 * credential and challenge chain, and the app-server route through it is measured
 * working.
 *
 * Two shapes exist and they are not interchangeable:
 *   - the desktop client ships a raw `resources/glm/zcode.cjs`;
 *   - `npm i -g zcode-app-cli` ships `vendor/zcode.cjs` (the real bundle) behind a thin
 *     `bin/zcode.js` wrapper. Only the bundle answers `app-server`, so the wrapper is
 *     never a valid candidate.
 * The npm prefix is not fixed (this machine uses `D:\npm-global`), so it is discovered
 * from PATH rather than assumed to be under APPDATA.
 *
 * @type {readonly string[]}
 */
export const ZCODE_CLI_CANDIDATES = [
  process.env.ZCODE_CLI_PATH,
  process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs')
    : undefined,
  process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'ZCode', 'resources', 'glm', 'zcode.cjs') : undefined,
  ...desktopDriveRootCandidates(),
  '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
  '/opt/ZCode/resources/glm/zcode.cjs',
  ...npmGlobalCliCandidates(),
].filter(
  /** @type {(candidate: string | undefined) => candidate is string} */
  ((candidate) => typeof candidate === 'string' && candidate !== ''),
)

/**
 * Windows desktop installs are not confined to LOCALAPPDATA/ProgramFiles: the installer
 * accepts any drive (this machine keeps the client at `D:\ZCode`), and no environment
 * variable points there. Probe the fixed-drive roots instead of missing the install.
 *
 * @returns {string[]} `<drive>:\ZCode\resources\glm\zcode.cjs` for every drive letter (win32 only).
 */
function desktopDriveRootCandidates() {
  if (process.platform !== 'win32') return []
  /** @type {string[]} */
  const candidates = []
  for (let code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code += 1) {
    candidates.push(`${String.fromCharCode(code)}:\\ZCode\\resources\\glm\\zcode.cjs`)
  }
  return candidates
}

/**
 * Locate a globally installed `zcode-app-cli` by looking at the directories on PATH.
 *
 * The global bin directory holds the `zcode`/`zcode.cmd` shim; the package itself is its
 * sibling `node_modules/zcode-app-cli`. This avoids hard-coding a prefix: npm's Windows
 * default is `%APPDATA%\npm`, but custom prefixes (this machine: `D:\npm-global`) are
 * common and only PATH knows about them.
 *
 * @returns {string[]} Candidate bundle paths (possibly none).
 */
function npmGlobalCliCandidates() {
  /** @type {string[]} */
  const found = []
  const pathValue = process.env.PATH ?? process.env.Path ?? ''
  for (const entry of pathValue.split(path.delimiter)) {
    const dir = entry.trim()
    if (dir === '') continue
    // Only consider directories that actually carry a zcode shim; otherwise every PATH
    // entry would contribute a bogus candidate.
    const shim = process.platform === 'win32' ? path.join(dir, 'zcode.cmd') : path.join(dir, 'zcode')
    try {
      if (!fs.statSync(shim).isFile()) continue
    } catch {
      continue
    }
    found.push(path.join(dir, 'node_modules', 'zcode-app-cli', 'vendor', 'zcode.cjs'))
  }
  return found
}

/**
 * Pick the CLI path: an explicit configuration value wins, otherwise the highest-versioned
 * candidate that exists on disk.
 *
 * Why not first-hit-wins: the desktop client auto-upgrades and keeps its bundled kernel
 * current, while `npm i -g zcode-app-cli` only moves when the user does. A stale npm
 * kernel selected by path order dies at startup once the desktop has downloaded a newer
 * builtin release the old CLI cannot decode (measured: 3.14.4 next to a desktop-written
 * revision-33 release exits before serving any request), so the newest kernel wins and
 * candidate order only breaks ties.
 *
 * @param {string | undefined} configuredPath The `zcodeCliPath` option ('' = auto).
 * @returns {string} The resolved path, or '' when nothing was found.
 */
export function locateZcodeCli(configuredPath) {
  const explicit = (configuredPath ?? '').trim()
  if (explicit !== '') return explicit
  /** @type {string[]} */
  const present = []
  for (const candidate of ZCODE_CLI_CANDIDATES) {
    try {
      if (fs.statSync(candidate).isFile()) present.push(candidate)
    } catch {
      /* Candidate absent; try the next one. */
    }
  }
  return selectBestCli(present, cliCandidateVersion)
}

/**
 * Choose the highest-versioned candidate. Ties keep the earlier candidate: the candidate
 * list is ordered from most deliberate (configured, default install locations) to most
 * guessed (drive roots, PATH scan).
 *
 * @param {readonly string[]} candidates Existing candidate paths.
 * @param {(candidate: string) => string} versionOf Version lookup for one candidate.
 * @returns {string} The winning candidate, or '' when the input is empty.
 */
export function selectBestCli(candidates, versionOf) {
  let best = ''
  let bestVersion = ''
  for (const candidate of candidates) {
    const version = versionOf(candidate)
    if (best === '' || compareVersions(version, bestVersion) > 0) {
      best = candidate
      bestVersion = version
    }
  }
  return best
}

/**
 * Compare two dotted version strings.
 *
 * Only the leading numeric `major.minor.patch` parts matter: npm publishes rebuild
 * counters as suffixes (`3.16.3-39`) and desktop builtin releases name directories by
 * plain version, so suffixes are ignored. An empty or malformed version ranks lowest.
 *
 * @param {string} a First version.
 * @param {string} b Second version.
 * @returns {number} Negative when `a < b`, positive when `a > b`, zero when equal.
 */
export function compareVersions(a, b) {
  const pa = parseVersionParts(a)
  const pb = parseVersionParts(b)
  for (let index = 0; index < 3; index += 1) {
    if (pa[index] !== pb[index]) return pa[index] - pb[index]
  }
  return 0
}

/**
 * @param {unknown} value Raw version string.
 * @returns {[number, number, number]} Numeric parts, 0 where missing.
 */
function parseVersionParts(value) {
  const parts = String(value ?? '')
    .split('-')[0]
    .split('.')
    .map((part) => {
      const numeric = Number.parseInt(part, 10)
      return Number.isFinite(numeric) ? numeric : 0
    })
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
}

/**
 * Version of one CLI candidate, for candidate ranking.
 *
 * npm layouts carry `package.json` next to the bundle. Desktop installs ship the raw
 * bundle with no manifest (measured: `resources/glm/` holds only `zcode.cjs` and plugin
 * dirs), but the client downloads a builtin release named after its own version into
 * `~/.zcode/v2/runtime/provider/`, so the newest release there is the closest available
 * proxy for the desktop kernel's version.
 *
 * @param {string} cliPath Resolved zcode.cjs path.
 * @returns {string} Best-known version, or '' when none is readable.
 */
export function cliCandidateVersion(cliPath) {
  const declared = readCliVersion(cliPath)
  if (declared !== '') return declared
  return newestRuntimeBuiltinVersion()
}

/**
 * Newest builtin release version the desktop client has downloaded.
 *
 * @returns {string} Version such as `3.16.3`, or '' when the runtime tree is absent.
 */
function newestRuntimeBuiltinVersion() {
  const root = runtimeProviderRoot(os.homedir())
  /** @type {import('node:fs').Dirent[]} */
  let versionDirs
  try {
    versionDirs = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return ''
  }
  let best = ''
  for (const versionDir of versionDirs) {
    // `0.0.0-dev` (a dev-channel marker) still parses as 0.0.0 and loses to any release.
    if (!versionDir.isDirectory() || !/^\d+\.\d+\.\d+/.test(versionDir.name)) continue
    if (best === '' || compareVersions(versionDir.name, best) > 0) best = versionDir.name
  }
  return best.split('-')[0]
}

/**
 * Reasoning level the bridge asks for when neither the caller nor the catalogue picks
 * one. The `session/setModel` schema requires the field, so a value must always exist.
 */
export const DEFAULT_REASONING_LEVEL = 'max'

/**
 * Capacities used when neither the CLI nor configuration states a value. The measured
 * signed-in account reports a 1M context window and a 128K output cap for the GLM-5.3
 * family, which is what these encode; they are fallbacks, not the catalogue.
 */
export const DEFAULT_MAX_TOKENS = 128000
export const DEFAULT_CONTEXT_WINDOW = 1000000

/**
 * Modalities this bridge can forward.
 *
 * The JSDoc type above is a compile-time-only reference (`tsc --checkJs`), erased at
 * runtime, so this module still has no runtime dependency on the harness packages and
 * `doctor` keeps working when the plugin cannot be loaded.
 *
 * @type {readonly import('@deepseek-ai/dsh-llm').ModelModality[]}
 */
export const MODEL_MODALITIES = ['text', 'image']

/**
 * Models to advertise when the CLI cannot be reached or reports nothing usable.
 *
 * A last resort, so a misconfigured or signed-out install still shows an actionable
 * entry instead of an empty provider. A working CLI always wins over this list.
 *
 * Measured on kernel 3.16.3 (2026-10-24): the GLM family is served through `zai-api`
 * for this account; `account:*` plan channels still win automatically in
 * {@link collapseCatalog} whenever the CLI reports them.
 *
 * @type {readonly CatalogEntry[]}
 */
export const FALLBACK_CATALOG = [
  {
    providerId: 'zai-api',
    modelId: 'GLM-5.3-Flash',
    label: 'GLM-5.3-Flash',
    providerLabel: 'Z.AI API',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens: DEFAULT_MAX_TOKENS,
    reasoningLevels: ['low', 'high', 'max'],
    defaultReasoningLevel: DEFAULT_REASONING_LEVEL,
    supportsImage: true,
  },
  {
    providerId: 'zai-api',
    modelId: 'GLM-5.3',
    label: 'GLM-5.3',
    providerLabel: 'Z.AI API',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens: DEFAULT_MAX_TOKENS,
    reasoningLevels: ['low', 'high', 'max'],
    defaultReasoningLevel: DEFAULT_REASONING_LEVEL,
    supportsImage: true,
  },
]

/**
 * One model the CLI reports as usable for this account.
 *
 * @typedef {object} CatalogEntry
 * @property {string} providerId CLI-side provider id (`account:...` for plan channels).
 * @property {string} modelId CLI-side model id, e.g. `GLM-5.3`.
 * @property {string} label Display name the CLI would show.
 * @property {string} providerLabel Display name of the owning provider.
 * @property {number | undefined} contextWindow Context capacity, when reported.
 * @property {number | undefined} maxOutputTokens Per-request output cap, when reported.
 * @property {readonly string[]} reasoningLevels Selectable reasoning levels, least first.
 * @property {string | undefined} defaultReasoningLevel Level the CLI itself would pick.
 * @property {boolean} supportsImage Whether the route accepts image input.
 */

/**
 * @param {unknown} value Candidate field.
 * @returns {string} The field when it is a non-empty string, otherwise ''.
 */
function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * @param {unknown} value Candidate field.
 * @returns {number | undefined} The field when it is a positive finite number.
 */
function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * Convert one `settings.model.available` entry into a {@link CatalogEntry}.
 *
 * The CLI's shape is `{ ref:{providerId,modelId}, label, providerLabel, contextWindow,
 * maxOutputTokens, reasoning:{levels:[{value,label}],defaultLevel},
 * properties:{inputFormat:{supportsImage}} }`. Fields are read defensively: a catalogue
 * entry without a provider/model ref is dropped rather than half-populated.
 *
 * @param {any} entry Raw catalogue entry from the CLI.
 * @returns {CatalogEntry | undefined} The normalised entry, or undefined when unusable.
 */
export function normalizeCatalogEntry(entry) {
  const providerId = text(entry?.ref?.providerId)
  const modelId = text(entry?.ref?.modelId)
  if (providerId === '' || modelId === '') return undefined
  const levels = Array.isArray(entry?.reasoning?.levels)
    ? entry.reasoning.levels
        .map((/** @type {any} */ level) => text(level?.value))
        .filter(/** @type {(value: string) => boolean} */ ((value) => value !== ''))
    : []
  return {
    providerId,
    modelId,
    label: text(entry?.label) || modelId,
    providerLabel: text(entry?.providerLabel) || providerId,
    contextWindow: positive(entry?.contextWindow),
    maxOutputTokens: positive(entry?.maxOutputTokens),
    reasoningLevels: levels,
    defaultReasoningLevel: text(entry?.reasoning?.defaultLevel) || undefined,
    supportsImage: entry?.properties?.inputFormat?.supportsImage === true,
  }
}

/**
 * Read the catalogue out of a `session/create` (or `session/close`) result.
 *
 * @param {any} result The `session/create` result.
 * @returns {CatalogEntry[]} Normalised entries, in CLI order.
 */
export function readModelCatalog(result) {
  const available = result?.settings?.model?.available
  if (!Array.isArray(available)) return []
  /** @type {CatalogEntry[]} */
  const catalog = []
  for (const entry of available) {
    const normalised = normalizeCatalogEntry(entry)
    if (normalised !== undefined) catalog.push(normalised)
  }
  return catalog
}

/**
 * Read the model the CLI selected for a freshly created session.
 *
 * @param {any} result The `session/create` result.
 * @returns {{ providerId: string, modelId: string } | undefined} The current model.
 */
export function readCurrentModel(result) {
  const providerId = text(result?.session?.model?.providerId)
  const modelId = text(result?.session?.model?.modelId)
  if (providerId === '' || modelId === '') return undefined
  return { providerId, modelId }
}

/**
 * Collapse the catalogue to one entry per model id.
 *
 * The same model id can be served by several providers (the plan account and a plain
 * API key both list `GLM-5.3`). DSH model ids must be unique within the provider, so the
 * bridge keeps a single entry per id and prefers account-backed channels: the whole
 * point of this plugin is to spend the CLI's own account, not a metered API key.
 *
 * @param {readonly CatalogEntry[]} catalog Entries as reported by the CLI.
 * @returns {CatalogEntry[]} One entry per model id, account channels first.
 */
export function collapseCatalog(catalog) {
  /** @type {Map<string, CatalogEntry>} */
  const byId = new Map()
  for (const entry of catalog) {
    const existing = byId.get(entry.modelId)
    if (existing === undefined) {
      byId.set(entry.modelId, entry)
      continue
    }
    const existingIsAccount = existing.providerId.startsWith('account:')
    const candidateIsAccount = entry.providerId.startsWith('account:')
    if (!existingIsAccount && candidateIsAccount) byId.set(entry.modelId, entry)
  }
  return [...byId.values()]
}

/**
 * Pick the catalogue entry that should serve a DSH model id.
 *
 * Accepts the collapsed ids DSH was shown plus explicit `providerId/modelId` refs, so a
 * user can pin one exact route in configuration when a model id is served twice. An empty
 * model means "no preference": the account's preferred route is returned, which is what
 * the diagnostics probes want (they ask "what would this account use by default?").
 *
 * @param {readonly CatalogEntry[]} catalog Entries as reported by the CLI.
 * @param {string} model DSH model id or explicit `providerId/modelId`.
 * @returns {CatalogEntry | undefined} The matching entry.
 */
export function pickCatalogEntry(catalog, model) {
  const wanted = text(model)
  const collapsed = collapseCatalog(catalog)
  if (wanted === '') return collapsed[0]
  const direct = collapsed.find((entry) => entry.modelId === wanted)
  if (direct !== undefined) return direct
  return catalog.find((entry) => `${entry.providerId}/${entry.modelId}` === wanted)
}

/**
 * A ZCode builtin runtime directory candidate.
 *
 * @typedef {object} BuiltinRuntime
 * @property {string} version Real client version (`3.14.4`), never a provenance label.
 * @property {string} activeFilePath Absolute zcode-builtin.json path.
 * @property {number} mtimeMs File modification time.
 * @property {number | undefined} revision `revision` declared inside the file.
 * @property {'bundled' | 'active'} source Where the file came from.
 */

/**
 * Version of the installed CLI package.
 *
 * Used for the client-fingerprint headers (`user-agent: ZCode/<version>`): the upstream WAF
 * rejects requests whose fingerprint does not look like a real client build. npm publishes
 * the CLI as `3.14.4-30`, where the trailing number is a rebuild counter, so the numeric
 * `3.14.4` is what goes into the header.
 *
 * @param {string} cliPath Resolved zcode.cjs path.
 * @returns {string} Version such as `3.14.4`, or '' when nothing readable is next to it.
 */
export function readCliVersion(cliPath) {
  const cliDir = path.dirname(text(cliPath))
  // The npm package root sits one level above vendor/ (where vendor/zcode.cjs lives).
  for (const file of [path.join(cliDir, '..', 'package.json'), path.join(cliDir, 'package.json')]) {
    try {
      const version = text(JSON.parse(fs.readFileSync(file, 'utf8'))?.version)
      if (version !== '') return version.split('-')[0]
    } catch {
      /* Not the CLI package root; try the next candidate. */
    }
  }
  return ''
}

/**
 * Root of the downloaded builtin release tree for a ZCode data directory.
 *
 * @param {string} base Data base directory (user home by default).
 * @returns {string} `<base>/.zcode/v2/runtime/provider/<platform>`.
 */
function runtimeProviderRoot(base) {
  const platformDir = process.platform === 'win32'
    ? `windows-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`
    : `${process.platform}-${process.arch}`
  return path.join(base, '.zcode', 'v2', 'runtime', 'provider', platformDir)
}

/**
 * Locate a zcode-builtin.json.
 *
 * Two sources exist and they are *not* interchangeable: the release shipped inside the
 * CLI installation (`<cliDir>/provider/zcode-builtin.json`, always decodable by that
 * exact CLI build) and the release the desktop client downloaded into
 * `<base>/.zcode/v2/runtime/provider/<platform>/<version>/<endpoint>/zcode-builtin.json`.
 * A newer client release can carry a schema the installed CLI rejects outright, so the
 * bundled copy is preferred and the runtime copy is only a fallback.
 *
 * This is inspection-only: the bridge does not feed either file to the CLI, because the
 * standalone CLI manages its own account and derives the same model list either way.
 *
 * @param {string | undefined} dataBaseDir ZCode data root ('' = user home).
 * @param {string} [cliPath] Resolved CLI path; its sibling `provider/` is checked first.
 * @returns {BuiltinRuntime | undefined} The chosen file, or undefined when none exists.
 */
export function resolveBuiltinRuntime(dataBaseDir, cliPath = '') {
  const explicitCli = text(cliPath)
  const cliVersion = explicitCli === '' ? '' : readCliVersion(explicitCli)
  if (explicitCli !== '') {
    const bundledPath = path.join(path.dirname(explicitCli), 'provider', 'zcode-builtin.json')
    const bundled = inspectBuiltin(bundledPath, 'bundled', cliVersion)
    if (bundled !== undefined) return bundled
  }
  const base = text(dataBaseDir) !== '' ? text(dataBaseDir) : os.homedir()
  const root = runtimeProviderRoot(base)
  /** @type {BuiltinRuntime | undefined} */
  let best
  /** @type {BuiltinRuntime | undefined} */
  let bestDev
  /** @type {import('node:fs').Dirent[]} */
  let versions
  try {
    versions = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const versionDir of versions) {
    if (!versionDir.isDirectory()) continue
    /** @type {import('node:fs').Dirent[]} */
    let endpoints
    try {
      endpoints = fs.readdirSync(path.join(root, versionDir.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const endpointDir of endpoints) {
      if (!endpointDir.isDirectory() || !endpointDir.name.startsWith('endpoint-')) continue
      const activeFilePath = path.join(root, versionDir.name, endpointDir.name, 'zcode-builtin.json')
      const candidate = inspectBuiltin(activeFilePath, 'active', versionDir.name)
      if (candidate === undefined) continue
      if (candidate.version === '0.0.0-dev') bestDev = candidate
      else if (best === undefined || candidate.mtimeMs > best.mtimeMs) best = candidate
    }
  }
  return best ?? bestDev
}

/**
 * Inspect one zcode-builtin.json without throwing on a malformed or missing file.
 *
 * @param {string} filePath Absolute path.
 * @param {'bundled' | 'active'} source Which source this path belongs to.
 * @param {string} [fallbackVersion] Version label when the path carries none.
 * @returns {BuiltinRuntime | undefined} The inspected file.
 */
function inspectBuiltin(filePath, source, fallbackVersion) {
  /** @type {fs.Stats} */
  let stat
  try {
    stat = fs.statSync(filePath)
  } catch {
    return undefined
  }
  /** @type {number | undefined} */
  let revision
  try {
    const release = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    revision = typeof release?.revision === 'number' ? release.revision : undefined
  } catch {
    /* Unreadable JSON is still worth reporting as a location, minus the revision. */
  }
  // Never return a provenance label here: `version` ends up in the client-fingerprint
  // headers, and `ZCode/bundled` is not a version the upstream WAF accepts.
  const version = text(fallbackVersion) !== '' ? text(fallbackVersion) : 'unknown'
  return { version, activeFilePath: filePath, mtimeMs: stat.mtimeMs, revision, source }
}

/**
 * Compute the `basedOnZCodeBuiltinRevision` form used by the CLI's registry.
 *
 * @param {string} activeFilePath Absolute zcode-builtin.json path.
 * @returns {string} `zcode-builtin:<revision>:<sha256 of the resolved path>`.
 * @throws {SyntaxError} When the builtin file is not valid JSON.
 */
export function computeBuiltinRevision(activeFilePath) {
  const release = JSON.parse(fs.readFileSync(activeFilePath, 'utf8'))
  const hash = createHash('sha256').update(path.resolve(activeFilePath)).digest('hex')
  return `zcode-builtin:${release?.revision}:${hash}`
}

/**
 * Read the provider inventory declared by zcode-builtin.json, for diagnostics.
 *
 * The release stores providers as an array under
 * `config.providerConfigRules.providerRules`; each item carries `providerId` and its
 * `config.api.type`/`config.access.type`. Older bridge code looked for a
 * top-level `providers` map, which never existed, so `doctor` always reported an empty
 * list.
 *
 * @param {string} activeFilePath Absolute zcode-builtin.json path.
 * @returns {{ revision: unknown, providers: { id: string, name: string, access: string, api: string }[] }} Summary.
 */
export function readBuiltinInventory(activeFilePath) {
  const release = JSON.parse(fs.readFileSync(activeFilePath, 'utf8'))
  /** @type {{ id: string, name: string, access: string, api: string }[]} */
  const providers = []
  const rules = release?.config?.providerConfigRules?.providerRules
  if (Array.isArray(rules)) {
    for (const rule of rules) {
      const id = text(rule?.providerId)
      if (id === '') continue
      providers.push({
        id,
        name: text(rule?.providerName) || id,
        access: text(rule?.config?.access?.type),
        api: text(rule?.config?.api?.type),
      })
    }
  }
  return { revision: release?.revision, providers }
}
