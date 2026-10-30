import assert from 'node:assert/strict'
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

function harness(onWrite) {
  const adapter = new ZcodeAppServerAdapter({ options: () => resolveOptions({}) })
  adapter.client.ensureStarted = async () => {}
  adapter.client.write = (message) => onWrite(message, (result, error) => {
    adapter.client.onData(JSON.stringify({ id: message.id, ...(error ? { error: { message: error } } : { result }) }) + '\n')
  })
  return adapter
}

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
