import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as native from '../community/runtime/native-runtime.mjs'
import { readStatus, saveConfig } from '../community/runtime/state.mjs'

const pluginId = 'zcode-community-retry@test'

function resolver(functions) {
  assert.equal(typeof native.resolveNativeSettingsFile, 'function', 'native attachment must ask the running Agent for its actual settings path')
  return native.resolveNativeSettingsFile(functions)
}

test('modern runtime settings disable retries even when legacy config enables them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-settings-'))
  const legacy = path.join(dir, 'config.json'), current = path.join(dir, 'setting.json')
  const original = globalThis.fetch
  try {
    fs.writeFileSync(legacy, JSON.stringify({ plugins: { enabledPlugins: { [pluginId]: true }, options: { [pluginId]: { intervalSeconds: 1 } } } }))
    fs.writeFileSync(current, JSON.stringify({ plugins: { enabledPlugins: { [pluginId]: false }, options: { [pluginId]: { intervalSeconds: 17 } } } }))
    const before = [fs.readFileSync(legacy), fs.readFileSync(current)]
    saveConfig(path.join(dir, 'retry-data'), {})
    const settingsFile = resolver([function getDefaultConfigPath() { return current }])
    assert.equal(settingsFile, current)
    assert.equal(native.nativeConfig(path.join(dir, 'retry-data'), settingsFile, pluginId).intervalMs, 17000)
    assert.equal(native.installNativeRetry({ dataDir: path.join(dir, 'retry-data'), pluginId, settingsFile }).reason, 'plugin_disabled')
    assert.equal(globalThis.fetch, original, 'a disabled user plugin must not wrap transport')
    assert.deepEqual([fs.readFileSync(legacy), fs.readFileSync(current)], before, 'resolving settings must not migrate or change either file')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('legacy Desktop keeps its actual config path when modern settings also exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-legacy-settings-'))
  const legacy = path.join(dir, 'config.json'), current = path.join(dir, 'setting.json')
  try {
    fs.writeFileSync(legacy, JSON.stringify({ plugins: { enabledPlugins: { [pluginId]: false } } }))
    fs.writeFileSync(current, JSON.stringify({ plugins: { enabledPlugins: { [pluginId]: true } } }))
    const settingsFile = resolver([function getDefaultConfigPath() { return legacy }])
    assert.equal(settingsFile, legacy)
    assert.equal(native.pluginEnabled(settingsFile, pluginId), false, 'the parent runtime owns its settings selection')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('runtime override is authoritative and is not replaced by another existing file', () => {
  const file = path.resolve('work', 'isolated-user-settings.json')
  assert.equal(resolver([function getDefaultConfigPath() { return file }]), file)
})

test('a bundle export accessor does not make the actual settings getter ambiguous', () => {
  const file = path.resolve('work', 'runtime-user-setting.json')
  const actual = function getDefaultConfigPath() { return file }
  const exports = { getDefaultConfigPath: () => actual }
  assert.equal(resolver([actual, exports.getDefaultConfigPath]), file)
})

test('unrelated revoked function proxies do not hide the runtime settings getter', () => {
  const file = path.resolve('work', 'runtime-user-setting.json')
  const revoked = Proxy.revocable(() => {}, {}); revoked.revoke()
  assert.equal(resolver([revoked.proxy, function getDefaultConfigPath() { return file }]), file)
})

test('a reused native runtime reports the verified settings path instead of choosing legacy', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-reused-settings-')), file = path.join(dir, 'setting.json')
  const original = globalThis.fetch
  try {
    fs.writeFileSync(file, JSON.stringify({ plugins: { enabledPlugins: { [pluginId]: true } } }))
    const args = { dataDir: dir, pluginId, pluginPid: process.pid, settingsFile: file, leaseFile: path.join(dir, 'lease.json') }
    assert.equal(native.installNativeRetry(args).active, true)
    assert.equal(native.installNativeRetry(args).reused, true)
    assert.equal(readStatus(dir).runtimes[0].settingsFile, file)
  } finally { globalThis[Symbol.for('zcode-community-retry.native.v1')]?.uninstall(); globalThis.fetch = original; fs.rmSync(dir, { recursive: true, force: true }) }
})

test('unavailable or ambiguous runtime settings path fails instead of falling back to legacy', () => {
  assert.throws(() => resolver([]), /Unsupported or ambiguous Agent settings/)
  assert.throws(() => resolver([function getDefaultConfigPath() { return path.resolve('config.json') }, function getDefaultConfigPath() { return path.resolve('setting.json') }]), /Unsupported or ambiguous Agent settings/)
  assert.throws(() => resolver([function getDefaultConfigPath() { return 'relative.json' }]), /Invalid Agent settings path/)
  assert.throws(() => resolver([function getDefaultConfigPath() { return undefined }]), /Invalid Agent settings path/)
})
