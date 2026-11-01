import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const keeperId = 'zcode-retry-keeper@tangyixiao-zcode-community'
const retryId = 'zcode-community-retry@tangyixiao-zcode-community'
const market = 'tangyixiao-zcode-community'

class KeeperError extends Error {}
class KeeperInactive extends Error {}
const fail = message => { throw new KeeperError(message) }
const equal = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
function inside(root, file) {
  const relative = path.relative(root, file)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'))

export function hookContext() {
  return { platform: process.platform, pid: process.pid, parentPid: process.ppid, execPath: process.execPath,
    keeperRoot: fileURLToPath(new URL('..', import.meta.url)), env: process.env }
}

function readParentMetadata() {
  const pid = process.ppid
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Get-Process -Id ${pid} | Select-Object @{Name='pid';Expression={$_.Id}},@{Name='execPath';Expression={$_.Path}} | ConvertTo-Json -Compress`],
  { encoding: 'utf8', windowsHide: true, timeout: 5000 }))
}

async function registration(context, io) {
  if (context.platform !== 'win32') fail('This Keeper integration requires Windows ZCode.')
  const env = context.env
  if (env.ZCODE_PLUGIN_ID !== keeperId || !env.ZCODE_PLUGIN_DATA || !path.isAbsolute(env.ZCODE_PLUGIN_DATA)) fail('Keeper must run as its registered ZCode plugin.')
  if (!env.ZCODE_PLUGIN_ROOT || !equal(fs.realpathSync(env.ZCODE_PLUGIN_ROOT), fs.realpathSync(context.keeperRoot))) fail('Keeper plugin root does not match its registration.')
  const data = path.resolve(env.ZCODE_PLUGIN_DATA), storage = path.dirname(path.dirname(data))
  if (path.basename(data) !== keeperId || path.basename(path.dirname(data)) !== 'data' || path.basename(storage) !== 'plugins') fail('Keeper data directory is outside the user plugin scope.')
  const realStorage = fs.realpathSync(storage)
  const index = fs.realpathSync(path.join(storage, 'installed_plugins.json'))
  if (!inside(realStorage, index)) fail('Plugin installation index is outside the user scope.')
  const records = json(index).plugins
  if (!Array.isArray(records)) fail('Plugin installation index is invalid.')
  function installed(id, name) {
    const matches = records.filter(record => record?.id === id)
    if (id === keeperId && matches.length === 0) throw new KeeperInactive()
    if (matches.length !== 1 || matches[0].scope !== 'user' || typeof matches[0].installPath !== 'string' || !path.isAbsolute(matches[0].installPath)) fail('Keeper and Retry require unique user-scope installations.')
    const cache = fs.realpathSync(path.join(storage, 'cache'))
    const trusted = fs.realpathSync(path.join(storage, 'cache', market, name))
    const root = fs.realpathSync(matches[0].installPath)
    if (!inside(cache, trusted) || !inside(trusted, root) || !fs.statSync(root).isDirectory()) fail('Plugin installation is outside its trusted marketplace cache.')
    const manifest = fs.realpathSync(path.join(root, '.zcode-plugin', 'plugin.json'))
    const metadata = json(manifest)
    if (!inside(root, manifest) || metadata.name !== name || typeof metadata.version !== 'string' || !metadata.version) fail('Installed plugin manifest identity does not match.')
    return { root, version: metadata.version }
  }
  const keeper = installed(keeperId, 'zcode-retry-keeper')
  if (!equal(keeper.root, context.keeperRoot)) fail('Keeper was invoked from a different installation.')
  const scope = { storage: realStorage }
  const bindingFile = path.join(data, 'bindings.json')
  if (fs.existsSync(bindingFile)) {
    const realData = fs.realpathSync(data), realFile = fs.realpathSync(bindingFile)
    if (!inside(realStorage, realData) || !inside(realData, realFile)) fail('Keeper binding configuration escapes its user data directory.')
    const bindings = json(realFile), parent = await (io.readParentMetadata ?? readParentMetadata)()
    if (bindings.version !== 1 || parent?.pid !== context.parentPid || typeof parent.execPath !== 'string' || !path.isAbsolute(parent.execPath)) fail('Keeper cannot verify the host for its explicit settings binding.')
    const executable = path.basename(parent.execPath).toLowerCase()
    const host = executable === 'zcode.exe' ? 'desktop' : executable === 'node.exe' && cliEntry(context.env) ? 'cli' : undefined
    if (!host) fail('Keeper settings bindings require the direct ZCode Desktop or official CLI parent.')
    scope.binding = bindings[host]
    if (typeof scope.binding !== 'string' || !path.isAbsolute(scope.binding)) fail('Keeper has no explicit settings binding for this host.')
    const value = scopeSettings(scope.binding, scope), option = value.plugins?.options?.[keeperId]?.settingsFile
    if (typeof option !== 'string' || !path.isAbsolute(option) || !equal(fs.realpathSync(option), fs.realpathSync(scope.binding))) fail('The settings binding does not match the official Keeper plugin option.')
    policy(value)
  }
  const retry = installed(retryId, 'zcode-community-retry')
  return { ...scope, retryRoot: retry.root, retryVersion: retry.version, dataDir: path.join(realStorage, 'data', retryId) }
}

function scopeSettings(file, scope) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !equal(path.dirname(fs.realpathSync(file)), path.dirname(scope.storage))) fail('The parent settings path does not belong to this plugin scope.')
  return json(file)
}

function policy(value) {
  if (value.plugins?.enabled === false || value.plugins?.enabledPlugins?.[keeperId] !== true) throw new KeeperInactive()
}

function settings(file, scope) {
  const value = scopeSettings(file, scope)
  policy(value)
  return value
}

function cliEntry(env) {
  if (!env.ZCODE_APP_CLI_ENTRY) return undefined
  const entry = fs.realpathSync(env.ZCODE_APP_CLI_ENTRY)
  const root = path.dirname(path.dirname(entry))
  if (path.basename(entry) !== 'zcode.js' || path.basename(path.dirname(entry)) !== 'bin' || json(path.join(root, 'package.json')).name !== 'zcode-app-cli') fail('The inherited ZCode CLI entry is not an installed zcode-app-cli package.')
  const cli = fs.realpathSync(path.join(root, 'vendor', 'zcode.cjs'))
  if (!inside(fs.realpathSync(root), cli)) fail('The CLI kernel escapes its installed package.')
  return cli
}

async function loadRetry(root) {
  const modulePath = file => {
    const real = fs.realpathSync(path.join(root, 'runtime', file))
    if (!inside(root, real)) fail('Retry runtime module escapes its installed package.')
    return pathToFileURL(real).href
  }
  const [attach, state] = await Promise.all([import(modulePath('native-attach.mjs')), import(modulePath('state.mjs'))])
  return { attachNativeRetry: attach.attachNativeRetry, directParentStartedAt: attach.directParentStartedAt, readStatus: state.readStatus }
}

async function runCli(command, args, options) {
  const result = spawnSync(command, args, { ...options, stdio: 'ignore', timeout: 15000 })
  if (result.error || result.status !== 0) fail('The official CLI could not restore the Retry enable switch.')
}

export async function ensureRetry(context = hookContext(), io = {}) {
  try { return await ensureRegisteredRetry(context, io) }
  catch (error) {
    if (error instanceof KeeperInactive) return { active: false, skipped: true, reason: 'keeper_disabled' }
    throw error
  }
}

async function ensureRegisteredRetry(context, io) {
  const scope = await registration(context, io)
  const retry = await (io.loadRetry ?? loadRetry)(scope.retryRoot)
  if (typeof retry.attachNativeRetry !== 'function' || typeof retry.readStatus !== 'function') fail('The installed Retry version does not support native attachment.')
  const candidate = retry.readStatus(scope.dataDir).runtimes.find(runtime => runtime.pid === context.parentPid && runtime.owner === 'zcode-plugin' && runtime.version === scope.retryVersion)
  const instance = candidate?.startedAt && await (io.directParentStartedAt ?? retry.directParentStartedAt)?.()
  const current = candidate?.startedAt && candidate.startedAt === instance ? candidate : undefined
  // A cached Hook may outlive the visible Keeper switch. Its own revocation is
  // a quiet no-op, including after the Retry controller has already stopped.
  if (current) {
    const value = settings(current.settingsFile, scope)
    if (current.live === true && value.plugins?.enabledPlugins?.[retryId] === true) return { active: true, pid: context.parentPid, reused: true }
  }

  const cliPath = cliEntry(context.env)
  fs.mkdirSync(scope.dataDir, { recursive: true })
  if (!inside(scope.storage, fs.realpathSync(scope.dataDir))) fail('Retry data directory escapes its user scope.')
  const leaseFile = path.join(scope.dataDir, `lease-${context.pid}.json`)
  const lease = { pid: context.pid, parentPid: context.parentPid, at: Date.now() }
  let native, ownsLease = false
  try {
    fs.writeFileSync(leaseFile, JSON.stringify(lease), { mode: 0o600, flag: 'wx' })
    ownsLease = true
    native = await retry.attachNativeRetry({ dataDir: scope.dataDir, pluginId: retryId, leaseFile, ...(cliPath ? { cliPath } : {}) })
    if (native?.verified !== true || native.pid !== context.parentPid) fail('Native Retry did not activate for this direct parent Agent.')
    if (scope.binding && !equal(fs.realpathSync(native.settingsFile), fs.realpathSync(scope.binding))) fail('The settings binding does not match the verified parent Agent.')
    const value = settings(native.settingsFile, scope)
    if (!native.active) fail('Native Retry did not activate for this direct parent Agent.')
    if (value.plugins?.enabledPlugins?.[retryId] !== true) {
      if (typeof native.cliPath !== 'string' || !path.isAbsolute(native.cliPath) || (cliPath && !equal(native.cliPath, cliPath))) fail('The verified parent did not return its CLI kernel path.')
      await (io.runCli ?? runCli)(context.execPath, [native.cliPath, 'plugins', 'enable', retryId, '-s', 'user'], {
        env: { ...context.env, ZCODE_CLI_SETTINGS_FILE: native.settingsFile }, shell: false, windowsHide: true,
      })
      if (settings(native.settingsFile, scope).plugins?.enabledPlugins?.[retryId] !== true) fail('The Retry enable switch was not restored by the official CLI.')
    }
    return { active: true, pid: native.pid, reused: native.reused === true }
  } finally { if (ownsLease) fs.rmSync(leaseFile, { force: true }) }
}

export function safeFailure(error) {
  if (error instanceof KeeperError) return error.message
  if (/inspector port is already in use/.test(error?.message ?? '')) return 'Another debugger owns the inspector port; it was left untouched. Retry is not ready for this Agent.'
  return 'Retry activation could not be verified. Check the Keeper/Retry installations or disable Keeper to use normal ZCode behavior.'
}
