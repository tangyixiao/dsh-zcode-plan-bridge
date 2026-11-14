import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setImmediate } from 'node:timers/promises'
import { ZcodeAppServerAdapter } from '../lib/app-server.js'
import { resolveOptions } from '../lib/index.js'
import { ToolkitRuntime } from '../lib/toolkit-runtime.js'
import { ToolkitSettingsStore } from '../lib/toolkit-state.js'

const catalog = ['first', 'second'].map(modelId => ({ providerId: 'plan', modelId, label: modelId, providerLabel: 'Plan', reasoningLevels: ['low', 'high'], defaultReasoningLevel: 'low' }))
function harness(t) {
  const scratch = fileURLToPath(new URL('../../work/zcode-toolkit-20261114/', import.meta.url))
  fs.mkdirSync(scratch, { recursive: true }); const dir = fs.mkdtempSync(path.join(scratch, 'adapter-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let config = resolveOptions({ zcodeDataBaseDir: dir, cliModels: [{ id: 'alias', cliModelId: 'first' }, { id: 'second' }] })
  const adapter = new ZcodeAppServerAdapter({ options: () => config })
  adapter.catalog = catalog
  const runtime = new ToolkitRuntime({ adapter, options: () => config, store: new ToolkitSettingsStore(path.join(dir, 'toolkit.json')) })
  t.after(() => runtime.dispose())
  return { adapter, runtime, change: next => { config = resolveOptions({ ...config, ...next, retryPolicy: undefined, communityRetry: undefined }) } }
}
test('visibility filters pins, rejects hiding every model and validates reasoning against alias route', async t => {
  const { runtime, adapter } = harness(t)
  let state = await runtime.state()
  await runtime.action({ action: 'settings', scope: state.scope, revision: state.settings.revision, patch: { hiddenModels: ['second'], reasoning: { alias: 'high' } } })
  assert.deepEqual((await adapter.listModels('zcode-cli')).map(m => m.id), ['alias'])
  assert.equal((await adapter.resolveRoute('alias')).reasoningLevel, 'high')
  assert.equal((await adapter.resolveRoute('alias', 'low')).reasoningLevel, 'low')
  await assert.rejects(adapter.resolveRoute('alias', 'invented'), /unsupported-reasoning/)
  state = await runtime.state()
  await assert.rejects(runtime.action({ action: 'settings', scope: state.scope, revision: state.settings.revision, patch: { hiddenModels: ['alias', 'second'] } }), /no-selectable-models/)
})
test('idle cache clearing never disposes adapter and rejects catalog/queued/active work', async t => {
  const { adapter } = harness(t)
  adapter.sessions.set('one', { sessionId: 'native-private-id' })
  adapter.turnLocks.set('queued', Promise.resolve())
  await assert.rejects(adapter.clearIdleCaches(), /runtime-busy/)
  adapter.turnLocks.clear(); adapter.catalogRead = new Promise(() => {})
  await assert.rejects(adapter.clearIdleCaches(), /runtime-busy/)
  adapter.catalogRead = undefined
  adapter.activeStreams.add({ onDeath() {} })
  await assert.rejects(adapter.clearIdleCaches(), /runtime-busy/)
  adapter.activeStreams.clear(); await adapter.clearIdleCaches()
  assert.equal(adapter.sessions.size, 0); assert.equal(adapter.client.disposed, false)
  assert.doesNotMatch(JSON.stringify(adapter.toolkitStatus()), /native-private-id/)
})
test('stale account mutations fail and runtime transitions reject queued work', async t => {
  const { runtime, adapter, change } = harness(t)
  const old = await runtime.state(); adapter.turnLocks.set('queued', Promise.resolve())
  change({ accountMode: 'start-plan' })
  assert.throws(() => adapter.syncToolkitIdentity(), /runtime-busy/)
  await assert.rejects(runtime.action({ action: 'settings', scope: old.scope, revision: old.settings.revision, patch: {} }), /account-changed/)
  adapter.turnLocks.clear(); adapter.syncToolkitIdentity()
  assert.equal(adapter.sessions.size, 0)
})
test('settings write detects a scope change during an asynchronous model read', async t => {
  const { runtime, adapter, change } = harness(t)
  const old = await runtime.state()
  adapter.allModels = async () => { change({ accountMode: 'start-plan' }); return [{ id: 'alias' }] }
  await assert.rejects(runtime.action({ action: 'settings', scope: old.scope, revision: old.settings.revision, patch: { hiddenModels: [] } }), /account-changed/)
})

test('a reused session receives an explicit reasoning change and observations keep missing usage unknown', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { adapter, runtime } = harness(t)
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'private prompt' }] }]
  let first = true; const selected = []
  adapter.ensureSession = async () => ({ sessionId: 'private-session', firstTurn: false, providerId: 'plan', modelId: 'first', reasoningLevel: 'low', sentLength: 1,
    // Force history rebuild, then have replacement represent the real first turn.
    sentFingerprint: '' })
  let calls = 0
  adapter.ensureSession = async () => {
    calls++
    if (calls === 1) return { sessionId: 'private-session', firstTurn: true }
    return adapter.sessions.get('reused')
  }
  adapter.client.write = message => {
    adapter.client.onData(JSON.stringify({ id: message.id, result: {} }) + '\n')
    if (message.method === 'session/setModel') selected.push(message.params.model.options.reasoningLevel)
    if (message.method === 'session/send') {
      const params = { sessionId: 'private-session', type: 'turn.completed', payload: { response: 'private response', resultType: 'success', ...(first ? {} : { usage: { inputTokens: 0, outputTokens: 2 } }) } }
      first = false
      adapter.client.onData(JSON.stringify({ method: 'session/event', params }) + '\n')
    }
  }
  // Use the native real stream's history fingerprint to create a reusable entry.
  const originalEnsure = adapter.ensureSession
  adapter.ensureSession = async (...args) => {
    const entry = await originalEnsure(...args)
    if (entry) adapter.sessions.set('reused', entry)
    return entry
  }
  const one = adapter.stream({ provider: 'zcode-cli', model: 'alias', sessionId: 'reused', messages })
  let completion = (async () => { for await (const _ of one) {} })()
  await setImmediate(); t.mock.timers.tick(1500); await setImmediate(); await completion
  assert.equal(runtime.log.read(runtime.scope())[0].usage, undefined)
  adapter.sessions.get('reused').providerId = 'plan'; adapter.sessions.get('reused').modelId = 'first'; adapter.sessions.get('reused').reasoningLevel = 'low'
  const two = adapter.stream({ provider: 'zcode-cli', model: 'alias', reasoningEffort: 'high', sessionId: 'reused', messages })
  completion = (async () => { for await (const _ of two) {} })()
  await setImmediate(); await completion
  assert.deepEqual(selected, ['high'])
  assert.deepEqual(runtime.log.read(runtime.scope())[0].usage, { inputTokens: 0, outputTokens: 2 })
  assert.doesNotMatch(JSON.stringify(runtime.log.read(runtime.scope())), /private/)
})
