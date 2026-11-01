import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isDesktopAgent } from '../community/runtime/native-attach.mjs'
import { installNativeRetry, nativeConfig, pluginEnabled } from '../community/runtime/native-runtime.mjs'
import { readStatus, saveConfig, writeRuntime } from '../community/runtime/state.mjs'

const pluginId = 'zcode-community-retry@test'
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

test('runtime status preserves only the safe process start identity, not private values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-start-identity-'))
  const startedAt = '2026-11-01T11:00:00.1234567Z'
  try {
    writeRuntime(dir, { pid: process.pid, startedAt, prompt: 'PRIVATE_PROMPT_MARKER', headers: { authorization: 'PRIVATE_TOKEN_MARKER' } })
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'runtimes', `${process.pid}.json`), 'utf8')), { pid: process.pid, startedAt })
  } finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()))
    assert.match(path.basename(dir), /^native-start-identity-/)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('native installation records and returns its verified process start identity', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-start-install-')), original = globalThis.fetch
  const settingsFile = path.join(dir, 'setting.json'), dataDir = path.join(dir, 'retry-data')
  const startedAt = '2026-11-01T11:00:00.1234567Z'
  try {
    fs.writeFileSync(settingsFile, '{}')
    saveConfig(dataDir, {})
    const args = { dataDir, settingsFile, pluginId, pluginPid: process.pid, leaseFile: path.join(dir, 'lease.json'), startedAt }
    assert.equal(installNativeRetry(args).startedAt, startedAt)
    assert.equal(installNativeRetry(args).startedAt, startedAt)
    assert.equal(readStatus(dataDir).runtimes[0].startedAt, startedAt)
  } finally {
    globalThis[Symbol.for('zcode-community-retry.native.v1')]?.uninstall()
    globalThis.fetch = original
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()))
    assert.match(path.basename(dir), /^native-start-install-/)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

for (const revoke of ['keeper-disabled', 'keeper-uninstalled', 'retry-uninstalled', 'global-disabled']) test(`keeper force runs Retry until ${revoke} and aborts its pending wait`, { timeout: 6000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-keeper-'))
  const settingsFile = path.join(dir, 'config.json'), dataDir = path.join(dir, 'retry-data')
  const retryId = 'zcode-community-retry@tangyixiao-zcode-community', keeperId = 'zcode-retry-keeper@tangyixiao-zcode-community'
  const root = path.join(dir, 'plugins/cache/tangyixiao-zcode-community/zcode-retry-keeper/0.1.0')
  const retryRoot = path.join(dir, 'plugins/cache/tangyixiao-zcode-community/zcode-community-retry/0.3.1')
  const keeperEntry = { id: keeperId, installPath: root }, retryEntry = { id: retryId, installPath: retryRoot }
  const index = path.join(dir, 'plugins/installed_plugins.json'), leaseFile = path.join(dir, 'lease.json')
  const settings = { plugins: { enabled: true, enabledPlugins: { [retryId]: false, [keeperId]: true } } }
  const original = globalThis.fetch
  let calls = 0
  const fixture = async () => { calls++; return new Response('{"code":"3008","msg":"user concurrency limit exceeded"}', { status: 429, headers: { 'content-type': 'application/json' } }) }
  try {
    fs.mkdirSync(path.join(root, '.zcode-plugin'), { recursive: true })
    fs.writeFileSync(path.join(root, '.zcode-plugin/plugin.json'), '{"name":"zcode-retry-keeper"}')
    fs.mkdirSync(retryRoot, { recursive: true })
    fs.writeFileSync(index, JSON.stringify({ plugins: [keeperEntry, retryEntry] }))
    fs.writeFileSync(settingsFile, JSON.stringify(settings))
    fs.writeFileSync(leaseFile, JSON.stringify({ pid: process.pid, parentPid: process.pid, at: Date.now() }))
    saveConfig(dataDir, { intervalMs: 20000 })
    globalThis.fetch = fixture
    assert.equal(installNativeRetry({ dataDir, settingsFile, pluginId: retryId, pluginRoot: retryRoot, pluginPid: process.pid, leaseFile }).active, true)
    const pending = globalThis.fetch('https://zcode.z.ai/api/messages', { method: 'POST', body: '{}' })
    const rejected = assert.rejects(pending, /disabled/)
    while (readStatus(dataDir).runtimes[0]?.state !== 'waiting') await wait(10)
    await wait(1100)
    assert.equal(readStatus(dataDir).active, true, 'the explicit keeper remains authoritative while Retry itself is false')
    if (revoke === 'keeper-disabled') settings.plugins.enabledPlugins[keeperId] = false
    else if (revoke === 'global-disabled') settings.plugins.enabled = false
    else fs.writeFileSync(index, JSON.stringify({ plugins: revoke === 'retry-uninstalled' ? [keeperEntry] : [retryEntry] }))
    fs.writeFileSync(settingsFile, JSON.stringify(settings))
    await rejected
    assert.equal(calls, 1)
    assert.equal(readStatus(dataDir).active, false)
    assert.equal(globalThis.fetch, fixture)
  } finally {
    globalThis[Symbol.for('zcode-community-retry.native.v1')]?.uninstall()
    globalThis.fetch = original
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()))
    assert.match(path.basename(dir), /^native-keeper-/)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('keeper force preserves terminal HTTP 405 and caller cancellation', { timeout: 3000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-keeper-cancel-'))
  const file = path.join(dir, 'config.json'), dataDir = path.join(dir, 'retry-data'), original = globalThis.fetch
  const retryId = 'zcode-community-retry@tangyixiao-zcode-community', keeperId = 'zcode-retry-keeper@tangyixiao-zcode-community'
  const root = path.join(dir, 'plugins/cache/tangyixiao-zcode-community/zcode-retry-keeper/0.1.0')
  let calls = 0, busy = false
  const fixture = async () => {
    calls++
    return busy ? new Response('{"code":"3008","msg":"user concurrency limit exceeded"}', { status: 429, headers: { 'content-type': 'application/json' } })
      : new Response('MethodNotAllowed', { status: 405 })
  }
  try {
    fs.mkdirSync(path.join(root, '.zcode-plugin'), { recursive: true })
    fs.writeFileSync(path.join(root, '.zcode-plugin/plugin.json'), '{"name":"zcode-retry-keeper"}')
    fs.writeFileSync(path.join(dir, 'plugins/installed_plugins.json'), JSON.stringify({ plugins: [{ id: keeperId, installPath: root }] }))
    fs.writeFileSync(file, JSON.stringify({ plugins: { enabledPlugins: { [retryId]: false, [keeperId]: true } } }))
    saveConfig(dataDir, { intervalMs: 20000 })
    globalThis.fetch = fixture
    assert.equal(installNativeRetry({ dataDir, settingsFile: file, pluginId: retryId, pluginPid: process.pid, leaseFile: path.join(dir, 'missing') }).active, true)
    const response = await globalThis.fetch('https://zcode.z.ai/api/messages', { method: 'POST', body: '{}' })
    assert.equal(response.status, 405)
    assert.equal(calls, 1, 'forcing activation must not change terminal error policy')
    busy = true
    const caller = new AbortController()
    const pending = globalThis.fetch('https://zcode.z.ai/api/messages', { method: 'POST', body: '{}', signal: caller.signal })
    const rejected = assert.rejects(pending, /fixture stopped/)
    while (readStatus(dataDir).runtimes[0]?.state !== 'waiting') await wait(10)
    caller.abort(new DOMException('fixture stopped', 'AbortError'))
    await rejected
    assert.equal(calls, 2)
    assert.equal(readStatus(dataDir).runtimes[0].state, 'cancelled')
  } finally {
    globalThis[Symbol.for('zcode-community-retry.native.v1')]?.uninstall()
    globalThis.fetch = original
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()))
    assert.match(path.basename(dir), /^native-keeper-cancel-/)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('native attachment accepts only the expected bundled Desktop Agent', () => {
  const identity = { pid: 123, nodeMajor: 24, fetch: 'function', argv: ['D:/ZCode/ZCode.exe', 'D:/ZCode/resources/glm/zcode.cjs', 'app-server', '--stdio', '--surface', 'desktop'] }
  assert.equal(isDesktopAgent(identity, 123), true)
  assert.equal(isDesktopAgent(identity, 124), false)
  for (const argv of [identity.argv.map(s => s === 'desktop' ? 'terminal' : s), identity.argv.filter(s => s !== '--stdio'), ['D:/Other/ZCode.exe', ...identity.argv.slice(1)], ['node.exe', ...identity.argv.slice(1)]]) {
    assert.equal(isDesktopAgent({ ...identity, argv }, 123), false)
  }
})

test('registered plugin survives discovery helper exit and brief settings replacement', { timeout: 15000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-registered-')), file = path.join(dir, 'setting.json'), original = globalThis.fetch
  const id = 'zcode-community-retry@inline', settings = { plugins: { enabled: true, dirs: [dir] } }
  try {
    saveConfig(dir, {})
    fs.writeFileSync(file, JSON.stringify(settings))
    installNativeRetry({ dataDir: dir, pluginId: id, pluginRoot: dir, pluginPid: 2147483647, leaseFile: path.join(dir, 'missing'), settingsFile: file })
    await wait(1100)
    assert.equal(readStatus(dir).active, true, 'discovery subprocess exit must not disable a still-registered plugin')
    fs.writeFileSync(file, '')
    await wait(1100)
    assert.equal(readStatus(dir).active, true, 'a brief unreadable settings file must not cancel user work')
    fs.writeFileSync(file, JSON.stringify({ plugins: { enabled: true, dirs: [] } }))
    await wait(1100)
    assert.equal(readStatus(dir).active, false, 'removing plugin registration must unload the runtime')
    assert.equal(globalThis.fetch, original)
  } finally { globalThis[Symbol.for('zcode-community-retry.native.v1')]?.uninstall(); globalThis.fetch = original; fs.rmSync(dir, { recursive: true, force: true }) }
})

test('native plugin uses the interval from ZCode plugin settings and validates it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-config-')), file = path.join(dir, 'setting.json')
  try {
    saveConfig(dir, { intervalMs: 5000 })
    fs.writeFileSync(file, JSON.stringify({ plugins: { options: { [pluginId]: { intervalSeconds: 12.5 } } } }))
    assert.equal(nativeConfig(dir, file, pluginId).intervalMs, 12500)
    fs.writeFileSync(file, JSON.stringify({ plugins: { options: { [pluginId]: { intervalSeconds: -1 } } } }))
    assert.throws(() => nativeConfig(dir, file, pluginId), /interval/)
    fs.writeFileSync(file, JSON.stringify({ plugins: { enabledPlugins: { [pluginId]: false } } }))
    assert.equal(pluginEnabled(file, pluginId), false)
    fs.writeFileSync(file, '{}'); saveConfig(dir, { mode: 'bounded' })
    assert.throws(() => nativeConfig(dir, file, pluginId), /unlimited/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('a temporary settings read failure receives its grace period even after long idle', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-idle-')), file = path.join(dir, 'config.json'), original = globalThis.fetch, now = Date.now
  try {
    saveConfig(dir, {})
    const settings = path.join(dir, 'setting.json'); fs.writeFileSync(settings, '{}')
    globalThis.fetch = async () => new Response('{}', { headers: { 'content-type': 'application/json' } })
    installNativeRetry({ dataDir: dir, pluginId, pluginPid: process.pid, leaseFile: path.join(dir, 'missing'), settingsFile: settings })
    Date.now = () => now() + 20000
    fs.writeFileSync(settings, '')
    const response = await globalThis.fetch('https://zcode.z.ai/api/messages', { method: 'POST', body: '{}' })
    assert.equal(response.status, 200)
    assert.equal(globalThis[Symbol.for('zcode-community-retry.native.v1')].active, true)
  } finally { Date.now = now; globalThis[Symbol.for('zcode-community-retry.native.v1')]?.uninstall(); globalThis.fetch = original; fs.rmSync(dir, { recursive: true, force: true }) }
})

test('plugin disable aborts pending retries, restores fetch and clears active status', { timeout: 6000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-lifecycle-')), file = path.join(dir, 'setting.json'), lease = path.join(dir, 'lease.json')
  const original = globalThis.fetch
  let calls = 0, pending
  const fixture = async () => { calls++; return new Response(JSON.stringify({ code: '3008', msg: 'user concurrency limit exceeded' }), { status: 429, headers: { 'content-type': 'application/json' } }) }
  globalThis.fetch = fixture
  const args = { dataDir: dir, pluginId, pluginPid: process.pid, leaseFile: lease, settingsFile: file }
  try {
    saveConfig(dir, { intervalMs: 20000 })
    fs.writeFileSync(file, '{}')
    fs.writeFileSync(lease, JSON.stringify({ pid: process.pid, parentPid: process.pid, at: Date.now() }))
    const installed = installNativeRetry(args), wrapped = globalThis.fetch
    assert.equal(installed.active, true)
    assert.equal(installNativeRetry(args).reused, true)
    assert.equal(globalThis.fetch, wrapped)
    pending = globalThis.fetch('https://zcode.z.ai/api/messages', { method: 'POST', body: '{}' })
    const rejection = assert.rejects(pending, /disabled/)
    while (readStatus(dir).runtimes[0]?.state !== 'waiting') await wait(10)
    fs.writeFileSync(file, JSON.stringify({ plugins: { enabledPlugins: { [pluginId]: false } } }))
    await rejection
    assert.equal(calls, 1)
    assert.equal(globalThis.fetch, fixture)
    assert.equal(readStatus(dir).active, false)
    assert.equal(installNativeRetry(args).active, false)
  } finally {
    globalThis[Symbol.for('zcode-community-retry.native.v1')]?.uninstall()
    globalThis.fetch = original
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('loss of plugin lease restores an unregistered runtime after its grace period', { timeout: 12000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-lease-')), lease = path.join(dir, 'lease.json'), original = globalThis.fetch
  try {
    saveConfig(dir, {})
    fs.writeFileSync(lease, JSON.stringify({ pid: process.pid, parentPid: process.pid, at: Date.now() }))
    assert.equal(installNativeRetry({ dataDir: dir, pluginId, pluginPid: process.pid, leaseFile: lease }).active, true)
    fs.rmSync(lease)
    const deadline = Date.now() + 8500
    while (globalThis.fetch !== original && Date.now() < deadline) await wait(20)
    assert.equal(globalThis.fetch, original)
    assert.equal(readStatus(dir).active, false)
  } finally {
    globalThis[Symbol.for('zcode-community-retry.native.v1')]?.uninstall()
    globalThis.fetch = original
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
