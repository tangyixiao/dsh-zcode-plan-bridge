import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'

import { ZcodeAppServerAdapter } from '../lib/app-server.js'
import { resolveOptions } from '../lib/index.js'

const created = {
  session: { sessionId: 'probe-1' },
  settings: { model: { available: [{
    ref: { providerId: 'account:zai-individual-coding-plan', modelId: 'probe-model' },
    label: 'Probe model',
    providerLabel: 'Plan',
    contextWindow: 1000000,
    maxOutputTokens: 128000,
  }] } },
}

function harness(onWrite, config = {}, managedAccount) {
  const adapter = new ZcodeAppServerAdapter({ options: () => ({ ...resolveOptions(config), managedAccount }) })
  adapter.client.ensureStarted = async () => {}
  adapter.client.write = (message) => onWrite(message, (result, error) => {
    adapter.client.onData(JSON.stringify({ id: message.id, ...(error ? { error: { message: error } } : { result }) }) + '\n')
  })
  return adapter
}

test('startup rejects when the process exits before or just after the ready notification', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-startup-exit-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const cli = path.join(dir, 'test-cli.cjs')
  const options = resolveOptions({ cliCwd: dir, zcodeDataBaseDir: dir, zcodeCliNode: process.execPath, zcodeCliPath: cli })
  const adapter = new ZcodeAppServerAdapter({ options: () => options })
  t.after(() => adapter.dispose())
  for (const source of ['process.exit(2)', "console.log(JSON.stringify({ method: 'startup/status', params: { phase: 'ready' } }))"]) {
    fs.writeFileSync(cli, source)
    await assert.rejects(adapter.client.ensureStarted(), { code: 'TRANSPORT' })
    assert.equal(adapter.client.child, undefined)
  }
})

test('model discovery closes its probe with an acknowledged protocol request', async () => {
  const frames = []
  const adapter = harness((message, reply) => {
    frames.push(message)
    reply(message.method === 'session/create' ? created : {})
  })
  const models = await adapter.listModels('zcode-cli')
  assert.equal(models[0].id, 'probe-model')
  const close = frames.find((frame) => frame.method === 'session/close')
  assert.equal(typeof close?.id, 'number', 'ZCode ignores close notifications without a request id')
  assert.deepEqual(close.params, { sessionId: 'probe-1' })
  assert.equal(adapter.client.pending.size, 0)
})

test('a failed probe close preserves the successfully discovered catalogue', async () => {
  const adapter = harness((message, reply) => {
    if (message.method === 'session/create') reply(created)
    else reply(undefined, 'probe already closed')
  })
  const models = await adapter.listModels('zcode-cli')
  assert.equal(models[0].id, 'probe-model')
})

test('a stalled CLI startup cannot keep the DSH model picker loading beyond 15 seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const adapter = harness(() => assert.fail('startup has not finished'))
  adapter.client.ensureStarted = () => new Promise(() => {})
  let models
  void adapter.listModels('zcode-cli').then((value) => { models = value })
  await setImmediate()
  t.mock.timers.tick(15000)
  await setImmediate()
  assert.ok(Array.isArray(models) && models.length > 0, 'show fallback models while CLI startup is stalled')
})

test('a slow discovery can populate the live catalogue after the picker fallback', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let finishStartup
  let starts = 0
  const adapter = harness((message, reply) => reply(message.method === 'session/create' ? created : {}))
  adapter.client.ensureStarted = () => {
    starts += 1
    return new Promise((resolve) => { finishStartup = resolve })
  }
  let first
  void adapter.listModels('zcode-cli').then((value) => { first = value })
  await setImmediate()
  t.mock.timers.tick(15000)
  await setImmediate()
  assert.ok(first?.length > 0)
  finishStartup()
  await setImmediate()
  const refreshed = await adapter.listModels('zcode-cli')
  assert.equal(refreshed[0].id, 'probe-model')
  assert.equal(starts, 1, 'reuse one in-flight catalogue probe')
})

function nativeCatalog(refs) {
  return {
    session: { sessionId: 'fixture', model: { providerId: 'api', modelId: 'same' } },
    settings: { model: { available: refs.map(([providerId, modelId]) => ({ ref: { providerId, modelId } })) } },
  }
}

for (const plan of ['account:zai-start-plan', 'account:bigmodel-start-plan']) {
  test(`Start Plan selects the advertised ${plan} route for a duplicated model ID`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const catalog = nativeCatalog([['account:zai-individual-coding-plan', 'same'], ['api', 'api-only'], [plan, 'same']])
    const frames = []
    const adapter = harness((message, reply) => {
      frames.push(message)
      reply(message.method === 'session/create' ? catalog : {})
    }, { accountMode: 'start-plan', cliModels: [{ id: 'plan-alias', cliModelId: 'same' }, { id: 'api-only' }] })
    assert.deepEqual((await adapter.listModels('zcode-cli')).map(entry => entry.id), ['plan-alias'])
    const pending = adapter.ensureSession('dsh', 'plan-alias')
    await setImmediate()
    t.mock.timers.tick(1500)
    const selected = await pending
    assert.equal(selected.providerId, plan)
    assert.equal(selected.modelId, 'same')
    assert.equal(frames.find(msg => msg.method === 'session/setModel').params.model.providerId, plan)
    assert.deepEqual(frames.map(frame => frame.method), [
      'session/create', 'session/close', 'session/create', 'session/subscribe', 'session/setMode', 'session/setModel',
    ])
  })
}

test('a plan missing from the current session cannot use an API route, a stale probe, a pin or a static model', async () => {
  const plan = nativeCatalog([['account:zai-start-plan', 'same']])
  const noPlan = nativeCatalog([['api', 'same']])
  let replyCatalog = plan
  const frames = []
  const adapter = harness((message, reply) => {
    frames.push(message)
    reply(message.method === 'session/create' ? replyCatalog : {})
  }, { accountMode: 'start-plan', cliModels: [{ id: 'pinned', cliModelId: 'same' }] })
  assert.deepEqual((await adapter.listModels('zcode-cli')).map(entry => entry.id), ['pinned'])
  replyCatalog = noPlan
  await assert.rejects(adapter.ensureSession('dsh', 'pinned'), /account-model-unavailable/)
  assert.deepEqual(await adapter.listModels('zcode-cli'), [])
  await assert.rejects(adapter.resolveRoute('pinned'), /account-model-unavailable/)
  await assert.rejects(adapter.validateAccountModel('pinned'), /account-model-unavailable/)
  assert.deepEqual(frames.map(frame => frame.method), ['session/create', 'session/close', 'session/create', 'session/close'])
  assert.equal(adapter.sessions.size, 0)
})

test('a Start Plan catalog probe failure propagates without a default route', async () => {
  const adapter = harness((_message, reply) => reply(undefined, 'offline'), { accountMode: 'start-plan' })
  await assert.rejects(adapter.listModels('zcode-cli'), /offline/)
  await assert.rejects(adapter.resolveRoute('missing'), /offline/)
})

test('two Start Plan providers sharing a model have distinct selectable IDs', async () => {
  const refs = [['account:zai-start-plan', 'same'], ['account:bigmodel-start-plan', 'same']]
  const adapter = harness((message, reply) => reply(message.method === 'session/create' ? nativeCatalog(refs) : {}), { accountMode: 'start-plan' })
  const models = await adapter.listModels('zcode-cli')
  assert.deepEqual(models.map(entry => entry.id), refs.map(ref => ref.join('/')))
  for (const [index, entry] of models.entries()) {
    const route = await adapter.resolveRoute(entry.id)
    assert.equal(route.providerId, refs[index][0])
    assert.equal(route.modelId, 'same')
  }
  await assert.rejects(adapter.resolveRoute('same'), /account-model-unavailable/)
})

test('a browser-linked profile selects only its signed-in provider family', async () => {
  const refs = [['account:zai-start-plan', 'same'], ['account:bigmodel-start-plan', 'same']]
  const adapter = harness((message, reply) => reply(message.method === 'session/create' ? nativeCatalog(refs) : {}),
    { accountMode: 'start-plan' }, { id: 'test', provider: 'bigmodel', generation: 'test-generation' })
  assert.deepEqual((await adapter.listModels('zcode-cli')).map(entry => entry.id), ['same'])
  assert.equal((await adapter.resolveRoute('same')).providerId, 'account:bigmodel-start-plan')
  await assert.rejects(adapter.resolveRoute('account:zai-start-plan/same'), /account-model-unavailable/)
})

test('a Start Plan child inherits the native data root and excludes host auth overrides', async t => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'bridge-launch-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const workspace = path.join(dir, 'project')
  fs.mkdirSync(workspace)
  const cli = path.join(dir, 'fixture.cjs')
  const capture = path.join(dir, 'capture.json')
  const names = ['ZCODE_APP_SERVER_AUTH_MODE', 'ZCODE_TEST_AUTH_HEADER', 'BRIDGE_TEST_API_KEY', 'BRIDGE_TEST_ALLOWED']
  const before = names.map(key => process.env[key])
  t.after(() => {
    names.forEach((key, index) => {
      if (before[index] === undefined) delete process.env[key]
      else process.env[key] = before[index]
    })
  })
  for (const key of names) process.env[key] = 'fixture'
  fs.writeFileSync(cli, `require('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
    args: process.argv.slice(2), cwd: process.cwd(), root: process.env.ZCODE_DATA_BASE_DIR,
    present: ${JSON.stringify(names)}.filter(key => key in process.env)
  }))`)
  const options = resolveOptions({ accountMode: 'start-plan', cliCwd: workspace, zcodeDataBaseDir: dir, zcodeCliPath: cli,
    zcodeCliNode: process.execPath, childEnvAllow: names })
  const adapter = new ZcodeAppServerAdapter({ options: () => options })
  t.after(() => adapter.dispose())
  await assert.rejects(adapter.client.ensureStarted(), { code: 'TRANSPORT' })
  assert.deepEqual(JSON.parse(fs.readFileSync(capture, 'utf8')), {
    args: ['app-server', '--surface', 'terminal', '--no-color'], cwd: dir, root: dir, present: ['BRIDGE_TEST_ALLOWED'],
  })
})
