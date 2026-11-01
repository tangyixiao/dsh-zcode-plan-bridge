import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

// Run this file serially with the other native integration fixtures: the product
// intentionally uses the one temporary inspector port and never takes it over.
// No real account, user profile, remote model, or pre-existing Agent is used.
const repository = fileURLToPath(new URL('..', import.meta.url))
const executable = 'D:/ZCode/ZCode.exe'
const cli = 'D:/ZCode/resources/glm/zcode.cjs'
const terminalCli = 'D:/npm-global/node_modules/zcode-app-cli/vendor/zcode.cjs'
const terminalEntry = 'D:/npm-global/node_modules/zcode-app-cli/bin/zcode.js'
const market = 'tangyixiao-zcode-community'
const retryId = `zcode-community-retry@${market}`
const keeperId = `zcode-retry-keeper@${market}`
const otherId = `unrelated-disabled@${market}`
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const json = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }
const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n') }

async function waitFor(predicate, timeout, description) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = predicate()
    if (result) return result
    await delay(40)
  }
  throw new Error(`Native Keeper fixture timed out: ${description}`)
}

async function assertInspectorFree() {
  const probe = net.createServer()
  await new Promise((resolve, reject) => {
    probe.once('error', error => reject(new Error(`Inspector 9229 is occupied; no existing debugger was touched (${error.code})`)))
    probe.listen(9229, '127.0.0.1', resolve)
  })
  await new Promise(resolve => probe.close(resolve))
}

function successStream() {
  return [
    { type: 'message_start', message: { id: 'msg_keeper_fixture', type: 'message', role: 'assistant', model: 'GLM-5.3-Flash', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'KEEPER_NATIVE_FIXTURE_OK' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

async function fixture(t, { cancel = false, terminal = false, prompt = false, inspectorBusy = false } = {}) {
  terminal ||= prompt
  const kernel = terminal ? terminalCli : cli
  const host = terminal ? process.execPath : executable
  assert.ok(fs.existsSync(host) && fs.existsSync(kernel), 'the real installed host kernel is required')
  if (terminal) assert.ok(fs.existsSync(terminalEntry), 'the official npm wrapper entry is required')
  await assertInspectorFree()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-force-keeper-native-'))
  const desktopSettingsFile = path.join(dir, '.zcode', 'cli', 'config.json')
  const settingsFile = path.join(path.dirname(desktopSettingsFile), terminal ? 'setting.json' : 'config.json')
  const pluginsRoot = path.join(path.dirname(settingsFile), 'plugins')
  const dataDir = path.join(pluginsRoot, 'data', retryId)
  const runtimeFile = pid => path.join(dataDir, 'runtimes', `${pid}.json`)
  const workspace = { workspacePath: dir, workspaceKey: 'force-keeper-native-isolated' }
  let child, server, busyInspector, sequence = 0, stderr = '', phase = cancel ? 'cancel' : 'recover'
  const pending = new Map(), notifications = [], terminals = [], calls = []
  const ownedChildren = new Set()
  const rejectPending = error => { for (const entry of pending.values()) entry.reject(error); pending.clear() }
  t.after(async () => {
    // These are only ChildProcess objects created by this fixture, never PIDs
    // discovered from the user's processes, runtime records, or inspector. The
    // public npm wrapper owns one runtime child, so its own tree is included.
    for (const owned of ownedChildren) {
      if (owned.exitCode !== null) continue
      const exited = new Promise(resolve => owned.once('exit', resolve))
      owned.stdin.end()
      await Promise.race([exited, delay(2500)])
      if (owned.exitCode === null) {
        if (prompt && process.platform === 'win32') {
          try { execFileSync('taskkill.exe', ['/PID', String(owned.pid), '/T', '/F'], { windowsHide: true, timeout: 5000, stdio: 'ignore' }) } catch {}
        } else owned.kill()
        await Promise.race([exited, delay(2000)])
      }
    }
    rejectPending(new Error('Native Keeper fixture stopped'))
    if (busyInspector?.listening) await new Promise(resolve => busyInspector.close(resolve))
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    const absolute = path.resolve(dir)
    assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()), 'cleanup stays within the fixture temporary root')
    assert.ok(path.basename(absolute).startsWith('zcode-force-keeper-native-'))
    fs.rmSync(absolute, { recursive: true, force: true })
  })

  server = createServer(async (request, response) => {
    // Drain synthetic fixture content without retaining or logging the body.
    for await (const ignored of request) {}
    const pathname = new URL(request.url, 'http://localhost').pathname
    if (request.method !== 'POST' || !pathname.endsWith('/messages')) { response.writeHead(404).end(); return }
    const auxiliary = request.headers['x-zcode-query-source'] && request.headers['x-zcode-query-source'] !== 'main_turn'
    const number = calls.filter(call => call.phase === phase).length
    const fail = !auxiliary && (phase !== 'recover' || number === 0)
    if (!auxiliary) calls.push({ phase, method: request.method, pathname, status: fail ? 429 : 200, at: Date.now() })
    if (fail) {
      response.writeHead(429, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: '3008', message: 'user concurrency limit exceeded' } }))
    } else response.writeHead(200, { 'content-type': 'text/event-stream' }).end(successStream())
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  if (inspectorBusy) {
    // This is this fixture's own synthetic listener, not an existing debugger.
    // A list response makes the production attach path refuse takeover.
    busyInspector = createServer((request, response) => response.writeHead(200, { 'content-type': 'application/json' }).end('[]'))
    await new Promise((resolve, reject) => { busyInspector.once('error', reject); busyInspector.listen(9229, '127.0.0.1', resolve) })
  }

  const installed = ['community', 'keeper'].map(source => {
    const sourceRoot = path.join(repository, source)
    const manifest = json(path.join(sourceRoot, '.zcode-plugin', 'plugin.json'))
    assert.ok(manifest?.name && manifest?.version, `${source} must have its actual plugin manifest`)
    const installPath = path.join(pluginsRoot, 'cache', market, manifest.name, manifest.version)
    fs.cpSync(sourceRoot, installPath, { recursive: true })
    return { id: `${manifest.name}@${market}`, name: manifest.name, marketplace: market, version: manifest.version,
      installPath, installedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), scope: 'user', source: `./${source}` }
  })
  assert.deepEqual(installed.map(plugin => plugin.id), [retryId, keeperId], 'use the production marketplace identities, never @inline')
  writeJson(path.join(pluginsRoot, 'installed_plugins.json'), { version: 1, plugins: installed })
  const settings = { features: { memory: false, mcp: true }, plugins: { enabled: true,
    enabledPlugins: { [retryId]: false, [keeperId]: true, [otherId]: false },
    options: { [retryId]: { intervalSeconds: cancel ? 20 : 0.03 }, [keeperId]: { settingsFile } } } }
  const cliSettingsFile = path.join(path.dirname(settingsFile), 'setting.json')
  const settingsFor = file => ({ ...settings, plugins: { ...settings.plugins,
    options: { ...settings.plugins.options, [keeperId]: { settingsFile: file } } } })
  writeJson(desktopSettingsFile, settingsFor(desktopSettingsFile))
  writeJson(cliSettingsFile, settingsFor(cliSettingsFile))
  writeJson(path.join(pluginsRoot, 'data', keeperId, 'bindings.json'), {
    version: 1, desktop: desktopSettingsFile, cli: cliSettingsFile,
  })
  const desktopSettingsHash = createHash('sha256').update(fs.readFileSync(desktopSettingsFile)).digest('hex')
  writeJson(path.join(dataDir, 'config.json'), { mode: 'unlimited', intervalMs: 30, allowedOrigins: [origin] })

  const builtinSource = [path.join(path.dirname(kernel), 'provider', 'zcode-builtin.json'),
    'D:/npm-global/node_modules/zcode-app-cli/vendor/provider/zcode-builtin.json'].find(file => fs.existsSync(file))
  assert.ok(builtinSource, 'fixture requires the shipped provider schema')
  const release = json(builtinSource)
  // Repoint every shipped model provider rule, not only the selected rule.
  for (const rule of [...release.config.providerConfigRules.providerRules, ...release.config.providerConfigRules.templateRules]) {
    if (rule.config?.api) rule.config.api.baseUrl = origin
  }
  release.config.providerConfigRules.providerRules.find(rule => rule.providerId === 'account:zai-start-plan').config.builtinModelIds = ['GLM-5.3-Flash']
  const builtin = path.join(dir, 'builtin.json'), personal = path.join(dir, 'personal.json')
  writeJson(builtin, release)
  writeJson(personal, { schemaVersion: 1, config: { providerConfigRules: { providerRules: prompt ? [{ providerId: 'keeper-local-fixture', providerName: 'Keeper local fixture', config: {
    group: 'standard-personal', access: { type: 'api-key', apiKey: 'local-fixture-only' },
    api: { type: 'anthropic-messages', baseUrl: origin }, personalModelIds: ['GLM-5.3-Flash'],
  } }] : [] },
    modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    defaultModelSelection: { providerId: prompt ? 'keeper-local-fixture' : 'account:zai-start-plan', modelId: 'GLM-5.3-Flash' } } })

  // Carry only Windows process-launch essentials, never inherited provider
  // credentials, proxy overrides, plugin identity, or account configuration.
  const essentials = /^(?:PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|TEMP|TMP|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/i
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => essentials.test(key)))
  Object.assign(env, { ELECTRON_RUN_AS_NODE: '1', HOME: dir, USERPROFILE: dir, ZCODE_DATA_BASE_DIR: dir,
    APPDATA: path.join(dir, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(dir, 'AppData', 'Local'),
    ZCODE_CLI_SETTINGS_FILE: settingsFile, ZCODE_APP_SERVER_AUTH_MODE: 'host', ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal, ZCODE_MODEL_RETRY_MAX_RETRIES: '0' })
  if (terminal) env.ZCODE_APP_CLI_ENTRY = terminalEntry
  if (prompt) delete env.ZCODE_APP_SERVER_AUTH_MODE
  child = spawn(host, prompt ? [terminalEntry, '-p', 'Reply only KEEPER_NATIVE_FIXTURE_OK; do not use tools.', '--no-color']
    : [kernel, 'app-server', '--stdio', '--surface', terminal ? 'terminal' : 'desktop', '--no-color'], { cwd: dir, windowsHide: true, env })
  ownedChildren.add(child)
  child.stderr.on('data', value => { stderr = (stderr + value).slice(-16000) })
  child.once('error', rejectPending)
  child.once('exit', code => rejectPending(new Error(`Owned fixture Agent exited ${code}`)))
  if (prompt) {
    let stdout = ''
    child.stdout.on('data', value => { stdout = (stdout + value).slice(-16000) })
    await waitFor(() => child.exitCode !== null, 65000, 'official npm -p invocation completion')
    // stdout contains only the fixed synthetic fixture turn and is not printed.
    const runtimeFiles = path.join(dataDir, 'runtimes')
    const runtimes = fs.existsSync(runtimeFiles) ? fs.readdirSync(runtimeFiles).filter(name => /^\d+\.json$/.test(name)).map(name => json(path.join(runtimeFiles, name))) : []
    return { calls, settingsFile, settings: () => json(settingsFile), exitCode: child.exitCode,
      outputContainsFixture: stdout.includes('KEEPER_NATIVE_FIXTURE_OK'), runtimes,
      desktopSettingsHash, currentDesktopSettingsHash: () => createHash('sha256').update(fs.readFileSync(desktopSettingsFile)).digest('hex'),
      stderrFixtureSummary: stderr.includes('[retry-keeper]') ? 'Keeper diagnostics present' : 'No Keeper diagnostic marker',
    }
  }
  const write = value => child.stdin.write(JSON.stringify(value) + '\n')
  createInterface({ input: child.stdout }).on('line', line => {
    let value; try { value = JSON.parse(line) } catch { return }
    if (value.id !== undefined && value.method) {
      write({ id: value.id, result: value.method === 'interaction/requestProviderRuntimeHeaders'
        ? { headersApplied: true, requestAuth: { apiKey: 'local-fixture-only', headers: {} } }
        : value.method === 'session/requestRuntimePreferences' ? { nativeSearchEnhancementsEnabled: false,
          memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false, modelContextBudgetStrategy: 'preflight-v1' } : {} })
    } else if (value.id !== undefined) {
      const entry = pending.get(value.id); pending.delete(value.id)
      if (value.error) entry?.reject(new Error(JSON.stringify(value.error))); else entry?.resolve(value.result)
    } else {
      notifications.push(value)
      if (['turn.completed', 'turn.failed'].includes(value.params?.type)) terminals.push(value.params)
    }
  })
  const request = (method, params, timeout = 45000) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Fixture RPC timed out: ${method}`)) }, timeout)
    pending.set(id, { resolve(value) { clearTimeout(timer); resolve(value) }, reject(error) { clearTimeout(timer); reject(error) } })
    write({ id, method, params })
  })
  await waitFor(() => notifications.some(value => ['ready', 'committing'].includes(value.params?.phase)), 25000, 'native Agent startup')
  await delay(1500)
  const listed = await request('plugins/list', { workspace })
  assert.ok(listed.plugins.some(plugin => plugin.id === retryId && plugin.enabled === false), 'Retry is genuinely disabled before session snapshot')
  assert.ok(listed.plugins.some(plugin => plugin.id === keeperId && plugin.enabled === true), 'the installed visible Keeper is enabled')
  const base = `zcode-builtin:${release.revision}:${createHash('sha256').update(path.resolve(builtin)).digest('hex')}`
  await request('provider/updateAccountConfig', { revision: 'keeper-loopback-fixture', basedOnZCodeBuiltinRevision: base,
    providers: { 'account:zai-start-plan': { access: { type: 'zhipu-account', entitled: true }, builtinModelIds: ['GLM-5.3-Flash'] } },
    states: { 'account:zai-start-plan': { availability: 'available', entitled: true, current: true } } })
  const created = await request('session/create', { workspace })
  const sessionId = created.session.sessionId
  await request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous', afterSeq: 0, includeSnapshot: true })
  await request('session/setModel', { sessionId, model: { providerId: 'account:zai-start-plan', modelId: 'GLM-5.3-Flash', options: { reasoningLevel: 'low' } } })

  return { child, calls, request, workspace, sessionId, dataDir, settingsFile, desktopSettingsHash,
    currentDesktopSettingsHash: () => createHash('sha256').update(fs.readFileSync(desktopSettingsFile)).digest('hex'),
    settings: () => json(settingsFile), runtime: () => json(runtimeFile(child.pid)),
    inspectorStillOwned: () => busyInspector?.listening === true,
    async closeOwnedInspector() { if (busyInspector?.listening) await new Promise(resolve => busyInspector.close(resolve)) },
    setPhase(value) { phase = value }, terminalCount: () => terminals.length,
    async send() { return request('session/send', { sessionId, content: 'Reply only KEEPER_NATIVE_FIXTURE_OK; do not use tools.' }) },
    async terminal(after = 0) { return waitFor(() => terminals[after], 45000, `turn terminal; native stderr: ${stderr.slice(-2500)}`) },
  }
}

test('native Keeper restores only Retry and protects the first disabled-plugin session', { timeout: 80000 }, async t => {
  const f = await fixture(t)
  assert.equal(f.calls.length, 0, 'no warmup generation may hide a next-session-only bootstrap')
  await f.send()
  const terminal = await f.terminal()
  assert.equal(terminal.type, 'turn.completed')
  assert.match(JSON.stringify(terminal), /KEEPER_NATIVE_FIXTURE_OK/)
  assert.deepEqual(f.calls.map(call => call.status), [429, 200], 'the very first turn retries through the native wrapper')
  assert.equal(f.runtime()?.owner, 'zcode-plugin')
  assert.equal(f.runtime()?.pid, f.child.pid, 'the Hook must attach its actual native parent')
  assert.equal(f.runtime()?.settingsFile, f.settingsFile)
  assert.equal(f.settings().plugins.enabledPlugins[retryId], true, 'the precise Retry user-scope setting is restored')
  assert.equal(f.settings().plugins.enabledPlugins[keeperId], true)
  assert.equal(f.settings().plugins.enabledPlugins[otherId], false, 'an unrelated disabled plugin remains disabled')
  assert.equal(f.settings().plugins.enabled, true)
  await assertInspectorFree()
})

test('native Keeper attachment retains real session cancellation during an unlimited retry wait', { timeout: 80000 }, async t => {
  const f = await fixture(t, { cancel: true })
  await f.send()
  await waitFor(() => {
    assert.equal(f.terminalCount(), 0, 'a completed or blocked turn cannot stand in for an active native retry wait')
    return f.calls.length === 1 && f.runtime()?.state === 'waiting'
  }, 40000, 'first failed physical request and retry wait')
  await f.request('session/stop', { sessionId: f.sessionId })
  await waitFor(() => f.runtime()?.state === 'cancelled', 4000, 'native cancellation acknowledgement')
  await delay(200)
  assert.equal(f.calls.length, 1, 'stop must cancel the existing wait before another physical request')
  assert.equal(f.settings().plugins.enabledPlugins[otherId], false)
  await assertInspectorFree()
})

test('disabling the visible Keeper revokes force Retry in the existing native session', { timeout: 80000 }, async t => {
  const f = await fixture(t)
  await f.send()
  const first = await f.terminal()
  assert.equal(first.type, 'turn.completed')
  assert.match(JSON.stringify(first), /KEEPER_NATIVE_FIXTURE_OK/, 'the fixture must first have protected a real local model turn')
  assert.deepEqual(f.calls.map(call => call.status), [429, 200])
  await f.request('plugins/setEnabled', { workspace: f.workspace, pluginId: retryId, scope: 'user', enabled: false })
  await delay(2200)
  assert.notEqual(f.runtime()?.state, 'disabled', 'explicit enabled Keeper must protect Retry even after the target setting is disabled again')
  assert.equal(f.settings().plugins.enabledPlugins[retryId], false)
  await f.request('plugins/setEnabled', { workspace: f.workspace, pluginId: keeperId, scope: 'user', enabled: false })
  await waitFor(() => f.runtime()?.state === 'disabled', 4000, 'Keeper disable revokes the native force policy')
  assert.equal(f.settings().plugins.enabledPlugins[retryId], false)
  assert.equal(f.settings().plugins.enabledPlugins[keeperId], false)
  assert.equal(f.settings().plugins.enabledPlugins[otherId], false)
  const before = f.calls.length, terminalIndex = f.terminalCount()
  f.setPhase('after-revoke')
  await f.send()
  assert.equal((await f.terminal(terminalIndex)).type, 'turn.failed')
  const nativeCalls = f.calls.length - before
  t.diagnostic(`After Keeper revocation the native turn failed after ${nativeCalls} physical loopback request(s).`)
  // The shipped kernel can make its own finite recovery attempts. Revocation
  // removes the community unlimited loop, not the kernel's normal fallback.
  assert.ok(nativeCalls >= 1 && nativeCalls <= 3, 'the revoked wrapper must leave only normal finite native recovery')
  await delay(200)
  assert.equal(f.calls.length - before, nativeCalls, 'no community retry may continue after the failed native turn')
  assert.equal(f.runtime()?.state, 'disabled')
  await assertInspectorFree()
})

test('terminal CLI Keeper repairs setting.json and protects its first session without changing Desktop config.json', { timeout: 80000 }, async t => {
  const f = await fixture(t, { terminal: true })
  assert.equal(f.calls.length, 0, 'the CLI case also starts without a warmup model turn')
  await f.send()
  const terminal = await f.terminal()
  assert.equal(terminal.type, 'turn.completed')
  assert.match(JSON.stringify(terminal), /KEEPER_NATIVE_FIXTURE_OK/)
  assert.deepEqual(f.calls.map(call => call.status), [429, 200])
  assert.equal(f.runtime()?.owner, 'zcode-plugin')
  assert.equal(f.runtime()?.pid, f.child.pid, 'the npm wrapper identity must resolve to this real terminal Agent')
  assert.equal(f.runtime()?.settingsFile, f.settingsFile)
  assert.equal(f.settings().plugins.enabledPlugins[retryId], true)
  assert.equal(f.settings().plugins.enabledPlugins[keeperId], true)
  assert.equal(f.settings().plugins.enabledPlugins[otherId], false)
  assert.equal(f.currentDesktopSettingsHash(), f.desktopSettingsHash, 'terminal enable must not rewrite the separate Desktop config.json')
  await assertInspectorFree()
})

test('official CLI -p invocation enables Retry and recovers locally in its first one-shot session', { timeout: 80000 }, async t => {
  const f = await fixture(t, { prompt: true })
  assert.equal(f.exitCode, 0, f.stderrFixtureSummary)
  assert.equal(f.outputContainsFixture, true, 'the actual public npm wrapper must finish its first synthetic prompt')
  assert.deepEqual(f.calls.map(call => call.status), [429, 200])
  assert.ok(f.runtimes.some(runtime => runtime?.owner === 'zcode-plugin' && runtime.settingsFile === f.settingsFile), 'the one-shot CLI kernel must have its own installed Retry runtime')
  assert.equal(f.settings().plugins.enabledPlugins[retryId], true)
  assert.equal(f.settings().plugins.enabledPlugins[keeperId], true)
  assert.equal(f.settings().plugins.enabledPlugins[otherId], false)
  assert.equal(f.currentDesktopSettingsHash(), f.desktopSettingsHash)
  await assertInspectorFree()
})

test('a never-attached Keeper can be disabled in its cached session while another listener owns the inspector port', { timeout: 80000 }, async t => {
  const f = await fixture(t, { inspectorBusy: true })
  await f.send()
  assert.equal((await f.terminal()).type, 'turn.completed', 'the enabled Keeper must block an unprotected first turn')
  assert.equal(f.calls.length, 0, 'no local model request is allowed before Retry has attached')
  assert.equal(f.runtime(), null, 'there has never been a native runtime or trusted status shortcut')
  assert.equal(f.inspectorStillOwned(), true, 'the fixture listener must be left untouched')
  await f.request('plugins/setEnabled', { workspace: f.workspace, pluginId: keeperId, scope: 'user', enabled: false })
  assert.equal(f.settings().plugins.enabledPlugins[retryId], false)
  assert.equal(f.settings().plugins.enabledPlugins[otherId], false)
  const terminalIndex = f.terminalCount()
  f.setPhase('never-attached-after-revoke')
  await f.send()
  assert.equal((await f.terminal(terminalIndex)).type, 'turn.failed', 'the disabled cached Hook must allow normal ZCode execution')
  t.diagnostic(`Never-attached revoked Keeper left ${f.calls.length} finite native loopback request(s).`)
  assert.ok(f.calls.length >= 1 && f.calls.length <= 3)
  assert.equal(f.runtime(), null)
  assert.equal(f.inspectorStillOwned(), true, 'disabling Keeper must not close someone else\'s listener')
  await f.closeOwnedInspector()
  await assertInspectorFree()
})
