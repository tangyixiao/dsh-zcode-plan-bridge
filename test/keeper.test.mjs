import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const keeperId = 'zcode-retry-keeper@tangyixiao-zcode-community'
const retryId = 'zcode-community-retry@tangyixiao-zcode-community'
const runtimeUrl = new URL('../keeper/runtime/keeper.mjs', import.meta.url)
async function runtime() {
  assert.ok(fs.existsSync(runtimeUrl), 'Keeper must provide a hook runtime')
  return import(runtimeUrl.href)
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-keeper-unit-'))
  const storage = path.join(dir, 'plugins')
  const keeperRoot = path.join(storage, 'cache', 'tangyixiao-zcode-community', 'zcode-retry-keeper', '0.1.0')
  const retryRoot = path.join(storage, 'cache', 'tangyixiao-zcode-community', 'zcode-community-retry', '0.3.2')
  for (const [root, name] of [[keeperRoot, 'zcode-retry-keeper'], [retryRoot, 'zcode-community-retry']]) {
    fs.mkdirSync(path.join(root, '.zcode-plugin'), { recursive: true })
    fs.writeFileSync(path.join(root, '.zcode-plugin', 'plugin.json'), JSON.stringify({ name, version: name === 'zcode-community-retry' ? '0.3.2' : '0.1.0' }))
  }
  const settingsFile = path.join(dir, 'config.json')
  const settings = { untouched: { value: 42 }, plugins: { enabledPlugins: { [keeperId]: true, [retryId]: false, 'other@test': false }, options: { 'other@test': { value: 17 } } } }
  fs.writeFileSync(settingsFile, JSON.stringify(settings))
  const records = [{ id: keeperId, installPath: keeperRoot, scope: 'user' }, { id: retryId, installPath: retryRoot, scope: 'user' }]
  const indexFile = path.join(storage, 'installed_plugins.json')
  fs.writeFileSync(indexFile, JSON.stringify({ plugins: records }))
  const dataDir = path.join(storage, 'data', retryId)
  const context = { platform: 'win32', pid: 12345, parentPid: 4242, execPath: process.execPath, keeperRoot,
    env: { ZCODE_PLUGIN_ID: keeperId, ZCODE_PLUGIN_ROOT: keeperRoot, ZCODE_PLUGIN_DATA: path.join(storage, 'data', keeperId) } }
  const cliPath = path.join(dir, 'ZCode', 'resources', 'glm', 'zcode.cjs')
  const calls = { attach: [], cli: [] }
  let live = []
  const io = {
    readParentMetadata: async () => ({ pid: 4242, execPath: path.join(dir, 'ZCode', 'ZCode.exe'), startedAt: '2026-11-01T01:00:00.0000000Z' }),
    directParentStartedAt: async () => '2026-11-01T01:00:00.0000000Z',
    loadRetry: async root => {
      assert.equal(root, retryRoot)
      return { readStatus: () => ({ runtimes: live }), attachNativeRetry: async args => {
        calls.attach.push(args)
        assert.equal(args.pluginId, retryId)
        assert.equal(args.dataDir, dataDir)
        const lease = JSON.parse(fs.readFileSync(args.leaseFile, 'utf8'))
        assert.equal(lease.pid, 12345)
        assert.equal(lease.parentPid, 4242)
        return { active: true, verified: true, pid: 4242, settingsFile, cliPath }
      } }
    },
    runCli: async (command, args, options) => {
      calls.cli.push({ command, args, options })
      const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
      saved.plugins.enabledPlugins[retryId] = true
      fs.writeFileSync(settingsFile, JSON.stringify(saved))
    },
  }
  return { dir, storage, keeperRoot, retryRoot, settingsFile, settings, indexFile, records, context, cliPath, dataDir, calls, io,
    bind: file => { fs.mkdirSync(context.env.ZCODE_PLUGIN_DATA, { recursive: true }); fs.writeFileSync(path.join(context.env.ZCODE_PLUGIN_DATA, 'bindings.json'), JSON.stringify({ version: 1, desktop: file })) },
    setLive: value => { live = value },
    close: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

test('Keeper restores only the registered Retry switch through the verified parent CLI', async () => {
  const api = await runtime(), f = fixture()
  try {
    const result = await api.ensureRetry(f.context, f.io)
    assert.equal(result.active, true)
    assert.equal(f.calls.attach.length, 1)
    assert.deepEqual(f.calls.cli[0].args, [f.cliPath, 'plugins', 'enable', retryId, '-s', 'user'])
    assert.equal(f.calls.cli[0].command, process.execPath)
    assert.equal(f.calls.cli[0].options.env.ZCODE_CLI_SETTINGS_FILE, f.settingsFile)
    assert.equal(f.calls.cli[0].options.env.ZCODE_PLUGIN_ID, keeperId, 'Keeper never impersonates the Retry plugin environment')
    assert.equal(f.calls.cli[0].options.shell, false)
    assert.equal(f.calls.cli[0].options.windowsHide, true)
    const after = JSON.parse(fs.readFileSync(f.settingsFile, 'utf8'))
    after.plugins.enabledPlugins[retryId] = false
    assert.deepEqual(after, f.settings, 'unrelated switches, options, and fields remain intact')
    assert.equal(fs.readdirSync(f.dataDir).some(name => name.startsWith('lease-')), false)
  } finally { f.close() }
})

test('an already live current Agent with Retry true does not reopen the inspector', async () => {
  const api = await runtime(), f = fixture()
  try {
    f.settings.plugins.enabledPlugins[retryId] = true
    fs.writeFileSync(f.settingsFile, JSON.stringify(f.settings))
    f.setLive([{ pid: 4242, version: '0.3.2', startedAt: '2026-11-01T01:00:00.0000000Z', owner: 'zcode-plugin', live: true, settingsFile: f.settingsFile }])
    assert.equal((await api.ensureRetry(f.context, f.io)).active, true)
    assert.equal(f.calls.attach.length, 0)
    assert.equal(f.calls.cli.length, 0)
  } finally { f.close() }
})

test('a runtime belonging to another Agent never satisfies this hook', async () => {
  const api = await runtime(), f = fixture()
  try {
    f.setLive([{ pid: 4243, owner: 'zcode-plugin', live: true, settingsFile: f.settingsFile }])
    await api.ensureRetry(f.context, f.io)
    assert.equal(f.calls.attach.length, 1)
  } finally { f.close() }
})

for (const bad of ['duplicate retry', 'missing retry', 'wrong manifest', 'outside cache', 'wrong environment']) {
  test(`Keeper refuses ${bad} without attaching or writing settings`, async () => {
    const api = await runtime(), f = fixture()
    try {
      if (bad === 'duplicate retry') f.records.push(f.records[1])
      if (bad === 'missing retry') f.records.pop()
      if (bad === 'wrong manifest') fs.writeFileSync(path.join(f.retryRoot, '.zcode-plugin', 'plugin.json'), JSON.stringify({ name: 'unrelated' }))
      if (bad === 'outside cache') f.records[1].installPath = f.dir
      if (bad === 'wrong environment') f.context.env.ZCODE_PLUGIN_ID = retryId
      fs.writeFileSync(f.settingsFile, JSON.stringify(f.settings))
      fs.writeFileSync(f.indexFile, JSON.stringify({ plugins: f.records }))
      const before = fs.readFileSync(f.settingsFile)
      await assert.rejects(api.ensureRetry(f.context, f.io))
      assert.equal(f.calls.attach.length, 0)
      assert.equal(f.calls.cli.length, 0)
      assert.deepEqual(fs.readFileSync(f.settingsFile), before)
    } finally { f.close() }
  })
}

test('an occupied debugger blocks new submission when the false Retry switch cannot be verified', async () => {
  const api = await runtime(), f = fixture()
  try {
    f.io.loadRetry = async () => ({ readStatus: () => ({ runtimes: [{ pid: 4242, version: '0.3.2', owner: 'zcode-plugin', live: true, settingsFile: f.settingsFile }] }),
      attachNativeRetry: async () => { throw new Error('Local inspector port is already in use; existing debugger was left untouched') } })
    await assert.rejects(api.ensureRetry(f.context, f.io), /inspector port/)
    assert.equal(f.calls.cli.length, 0)
    assert.equal(JSON.parse(fs.readFileSync(f.settingsFile, 'utf8')).plugins.enabledPlugins[retryId], false)
  } finally { f.close() }
})

test('an old Retry runtime cannot satisfy readiness after the installed package was upgraded', async () => {
  const api = await runtime(), f = fixture()
  try {
    f.settings.plugins.enabledPlugins[retryId] = true
    fs.writeFileSync(f.settingsFile, JSON.stringify(f.settings))
    f.setLive([{ pid: 4242, version: '0.3.1', owner: 'zcode-plugin', live: true, settingsFile: f.settingsFile }])
    await api.ensureRetry(f.context, f.io)
    assert.equal(f.calls.attach.length, 1, 'an old status record must be freshly verified')
  } finally { f.close() }
})

for (const disabled of ['keeper', 'global']) test(`cached hooks become a quiet no-op after ${disabled} disable`, async () => {
  const api = await runtime(), f = fixture()
  try {
    if (disabled === 'keeper') f.settings.plugins.enabledPlugins[keeperId] = false
    else f.settings.plugins.enabled = false
    fs.writeFileSync(f.settingsFile, JSON.stringify(f.settings))
    f.setLive([{ pid: 4242, version: '0.3.2', startedAt: '2026-11-01T01:00:00.0000000Z', owner: 'zcode-plugin', live: false, settingsFile: f.settingsFile }])
    const before = fs.readFileSync(f.settingsFile)
    const result = await api.ensureRetry(f.context, f.io)
    assert.equal(result.skipped, true)
    assert.equal(f.calls.attach.length, 0)
    assert.equal(f.calls.cli.length, 0)
    assert.deepEqual(fs.readFileSync(f.settingsFile), before)
  } finally { f.close() }
})

test('revocation during attachment does not restore Retry or block normal ZCode behavior', async () => {
  const api = await runtime(), f = fixture()
  try {
    const attach = (await f.io.loadRetry(f.retryRoot)).attachNativeRetry
    f.io.loadRetry = async () => ({ readStatus: () => ({ runtimes: [] }), attachNativeRetry: async args => {
      const result = await attach(args)
      f.settings.plugins.enabledPlugins[keeperId] = false
      fs.writeFileSync(f.settingsFile, JSON.stringify(f.settings))
      return { ...result, active: false, reason: 'plugin_disabled' }
    } })
    assert.equal((await api.ensureRetry(f.context, f.io)).skipped, true)
    assert.equal(f.calls.cli.length, 0)
  } finally { f.close() }
})

test('a failed exclusive lease creation never removes an existing lease', async () => {
  const api = await runtime(), f = fixture()
  try {
    fs.mkdirSync(f.dataDir, { recursive: true })
    const leaseFile = path.join(f.dataDir, 'lease-12345.json')
    fs.writeFileSync(leaseFile, 'existing-lease')
    await assert.rejects(api.ensureRetry(f.context, f.io))
    assert.equal(fs.readFileSync(leaseFile, 'utf8'), 'existing-lease')
  } finally { f.close() }
})

test('a recent same-version status cannot authorize a reused PID from another process instance', async () => {
  const api = await runtime(), f = fixture()
  try {
    f.settings.plugins.enabledPlugins[retryId] = true
    fs.writeFileSync(f.settingsFile, JSON.stringify(f.settings))
    f.setLive([{ pid: 4242, version: '0.3.2', startedAt: '2026-10-31T01:00:00.0000000Z', at: Date.now(), owner: 'zcode-plugin', live: true, settingsFile: f.settingsFile }])
    await api.ensureRetry(f.context, f.io)
    assert.equal(f.calls.attach.length, 1, 'the actual parent start time must be checked before accepting a live record')
  } finally { f.close() }
})

for (const disabled of ['keeper', 'global']) test(`explicit self-bound settings allow ${disabled} revocation before any successful attach`, async () => {
  const api = await runtime(), f = fixture()
  try {
    f.bind(f.settingsFile)
    f.settings.plugins.options[keeperId] = { settingsFile: f.settingsFile }
    if (disabled === 'keeper') f.settings.plugins.enabledPlugins[keeperId] = false
    else f.settings.plugins.enabled = false
    fs.writeFileSync(f.settingsFile, JSON.stringify(f.settings))
    f.io.loadRetry = async () => { throw new Error('Retry must not load or open an inspector after this policy was disabled') }
    assert.equal((await api.ensureRetry(f.context, f.io)).skipped, true)
    assert.equal(f.calls.cli.length, 0)
  } finally { f.close() }
})

test('a settings argument without its exact official plugin option cannot assert that Keeper is disabled', async () => {
  const api = await runtime(), f = fixture()
  try {
    f.bind(f.settingsFile)
    f.settings.plugins.enabledPlugins[keeperId] = false
    fs.writeFileSync(f.settingsFile, JSON.stringify(f.settings))
    await assert.rejects(api.ensureRetry(f.context, f.io), /bind|option/i)
    assert.equal(f.calls.attach.length, 0)
  } finally { f.close() }
})

test('a self-bound settings file must match the actual parent before any enable command', async () => {
  const api = await runtime(), f = fixture()
  try {
    const other = path.join(f.dir, 'setting.json')
    const bound = structuredClone(f.settings)
    bound.plugins.options[keeperId] = { settingsFile: other }
    fs.writeFileSync(other, JSON.stringify(bound))
    f.bind(other)
    await assert.rejects(api.ensureRetry(f.context, f.io), /bind|match/i)
    assert.equal(f.calls.cli.length, 0)
  } finally { f.close() }
})

test('unverified parent settings never become a CLI override', async () => {
  const api = await runtime(), f = fixture()
  try {
    f.io.loadRetry = async () => ({ readStatus: () => ({ runtimes: [] }), attachNativeRetry: async () => ({ active: true, verified: true, pid: 4242, settingsFile: path.join(f.dir, 'unrelated', 'config.json'), cliPath: f.cliPath }) })
    await assert.rejects(api.ensureRetry(f.context, f.io))
    assert.equal(f.calls.cli.length, 0)
  } finally { f.close() }
})

test('CLI success without a saved exact enable flag fails readiness', async () => {
  const api = await runtime(), f = fixture()
  try {
    f.io.runCli = async () => {}
    await assert.rejects(api.ensureRetry(f.context, f.io), /enable|restor/i)
  } finally { f.close() }
})

test('the executable hook blocks unsupported invocation without reading or echoing stdin', async () => {
  await runtime()
  const run = spawnSync(process.execPath, [new URL('../keeper/bin/ensure.mjs', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, '$1'), 'UserPromptSubmit'], {
    input: JSON.stringify({ prompt: 'KEEPER_PRIVATE_PROMPT_MARKER', account: 'PRIVATE_ACCOUNT_MARKER' }), encoding: 'utf8', timeout: 5000,
    env: { ...process.env, ZCODE_PLUGIN_ID: 'unrelated@test' }, windowsHide: true,
  })
  assert.equal(run.status, 0)
  assert.equal(JSON.parse(run.stdout).continue, false)
  assert.equal(`${run.stdout}${run.stderr}`.includes('PRIVATE_'), false)
})
