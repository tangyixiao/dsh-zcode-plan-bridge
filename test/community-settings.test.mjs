import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as native from '../community/runtime/native-runtime.mjs'
import { readStatus, saveConfig } from '../community/runtime/state.mjs'

const pluginId = 'zcode-community-retry@test'
const forcedRetryId = 'zcode-community-retry@tangyixiao-zcode-community'
const keeperId = 'zcode-retry-keeper@tangyixiao-zcode-community'

function keeperFixture(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-keeper-settings-'))
  const file = path.join(dir, 'config.json')
  const root = path.join(dir, 'plugins', 'cache', 'tangyixiao-zcode-community', 'zcode-retry-keeper', '0.1.0')
  const index = path.join(dir, 'plugins', 'installed_plugins.json')
  const manifest = path.join(root, '.zcode-plugin', 'plugin.json')
  const settings = { plugins: { enabled: true, enabledPlugins: { [forcedRetryId]: false, [keeperId]: true } } }
  fs.mkdirSync(path.dirname(manifest), { recursive: true })
  fs.writeFileSync(manifest, JSON.stringify({ name: 'zcode-retry-keeper', version: '0.1.0' }))
  fs.writeFileSync(index, JSON.stringify({ plugins: [{ id: keeperId, installPath: root }] }))
  fs.writeFileSync(file, JSON.stringify(settings))
  try { run({ dir, file, root, index, manifest, settings }) }
  finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()))
    assert.match(path.basename(dir), /^retry-keeper-settings-/)
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('explicit installed keeper opt-in can keep only its exact Retry enabled without changing settings', () => {
  keeperFixture(({ file, index, settings }) => {
    settings.plugins.enabledPlugins['unrelated@test'] = false
    settings.plugins.enabledPlugins['zcode-community-retry@inline'] = false
    fs.writeFileSync(file, JSON.stringify(settings))
    const before = [fs.readFileSync(file), fs.readFileSync(index)]
    assert.equal(native.pluginEnabled(file, forcedRetryId), true)
    assert.equal(native.pluginEnabled(file, 'unrelated@test'), false)
    assert.equal(native.pluginEnabled(file, 'zcode-community-retry@inline'), false)
    assert.deepEqual([fs.readFileSync(file), fs.readFileSync(index)], before)
  })
})

test('keeper opt-in is revoked by its own disable, uninstall, or global plugin disable', () => {
  keeperFixture(({ file, index, settings }) => {
    assert.equal(native.pluginEnabled(file, forcedRetryId), true)
    settings.plugins.enabledPlugins[keeperId] = false
    fs.writeFileSync(file, JSON.stringify(settings))
    assert.equal(native.pluginEnabled(file, forcedRetryId), false)
    delete settings.plugins.enabledPlugins[keeperId]
    fs.writeFileSync(file, JSON.stringify(settings))
    assert.equal(native.pluginEnabled(file, forcedRetryId), false, 'keeper requires an explicit true opt-in')
    settings.plugins.enabledPlugins[keeperId] = true
    settings.plugins.enabled = false
    fs.writeFileSync(file, JSON.stringify(settings))
    assert.equal(native.pluginEnabled(file, forcedRetryId), false)
    settings.plugins.enabled = true
    fs.writeFileSync(file, JSON.stringify(settings))
    fs.writeFileSync(index, JSON.stringify({ plugins: [] }))
    assert.equal(native.pluginEnabled(file, forcedRetryId), false)
  })
})

test('keeper force requires its exact registered identity and a real manifest within the user cache', () => {
  keeperFixture(({ dir, file, root, index, manifest }) => {
    const otherMarketRoot = path.join(dir, 'plugins/cache/other-market/zcode-retry-keeper/0.1.0')
    fs.mkdirSync(path.join(otherMarketRoot, '.zcode-plugin'), { recursive: true })
    fs.writeFileSync(path.join(otherMarketRoot, '.zcode-plugin/plugin.json'), '{"name":"zcode-retry-keeper"}')
    for (const entry of [
      { id: 'zcode-retry-keeper@other-market', installPath: root },
      { id: keeperId, installPath: otherMarketRoot },
      { id: keeperId, installPath: path.relative(dir, root) },
      { id: keeperId, installPath: path.join(root, 'missing') },
      { id: keeperId, installPath: dir },
    ]) {
      fs.writeFileSync(index, JSON.stringify({ plugins: [entry] }))
      assert.equal(native.pluginEnabled(file, forcedRetryId), false)
    }
    fs.writeFileSync(index, JSON.stringify({ plugins: [{ id: keeperId, installPath: root }, { id: keeperId, installPath: root }] }))
    assert.equal(native.pluginEnabled(file, forcedRetryId), false, 'ambiguous keeper registration must not force')
    fs.writeFileSync(index, JSON.stringify({ plugins: [{ id: keeperId, installPath: root }] }))
    fs.writeFileSync(manifest, JSON.stringify({ name: 'another-plugin' }))
    assert.equal(native.pluginEnabled(file, forcedRetryId), false)
    fs.writeFileSync(index, '{broken')
    assert.equal(native.pluginEnabled(file, forcedRetryId), false, 'unreadable keeper evidence cannot authorize force')
    const normal = JSON.parse(fs.readFileSync(file, 'utf8'))
    normal.plugins.enabledPlugins[forcedRetryId] = true
    fs.writeFileSync(file, JSON.stringify(normal))
    assert.equal(native.pluginEnabled(file, forcedRetryId), true, 'normal explicit Retry enable does not depend on keeper evidence')
  })
})

test('keeper force rejects a cache junction escaping to another directory', () => {
  keeperFixture(({ dir, file, root, index }) => {
    const outside = path.join(dir, 'outside-cache'), alias = path.join(path.dirname(root), 'linked')
    fs.mkdirSync(path.join(outside, '.zcode-plugin'), { recursive: true })
    fs.writeFileSync(path.join(outside, '.zcode-plugin/plugin.json'), JSON.stringify({ name: 'zcode-retry-keeper' }))
    fs.symlinkSync(outside, alias, process.platform === 'win32' ? 'junction' : 'dir')
    fs.writeFileSync(index, JSON.stringify({ plugins: [{ id: keeperId, installPath: alias }] }))
    assert.equal(native.pluginEnabled(file, forcedRetryId), false)
  })
})

test('keeper in legacy Desktop config cannot change the separate CLI setting', () => {
  keeperFixture(({ dir, file }) => {
    const cliSettings = path.join(dir, 'setting.json')
    fs.writeFileSync(cliSettings, JSON.stringify({ plugins: { enabledPlugins: { [forcedRetryId]: false } } }))
    assert.equal(native.pluginEnabled(file, forcedRetryId), true)
    assert.equal(native.pluginEnabled(cliSettings, forcedRetryId), false)
  })
})

test('CLI setting.json can explicitly opt into keeper without forcing other plugins', () => {
  keeperFixture(({ dir, settings }) => {
    const cliSettings = path.join(dir, 'setting.json')
    settings.plugins.enabledPlugins['other@test'] = false
    fs.writeFileSync(cliSettings, JSON.stringify(settings))
    assert.equal(native.pluginEnabled(cliSettings, forcedRetryId), true)
    assert.equal(native.pluginEnabled(cliSettings, 'other@test'), false)
    settings.plugins.enabledPlugins[keeperId] = false
    fs.writeFileSync(cliSettings, JSON.stringify(settings))
    assert.equal(native.pluginEnabled(cliSettings, forcedRetryId), false)
  })
})

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
