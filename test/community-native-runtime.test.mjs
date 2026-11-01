import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isDesktopAgent } from '../community/runtime/native-attach.mjs'
import { installNativeRetry, nativeConfig, pluginEnabled } from '../community/runtime/native-runtime.mjs'
import { readStatus, saveConfig } from '../community/runtime/state.mjs'

const pluginId = 'zcode-community-retry@test'
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

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
