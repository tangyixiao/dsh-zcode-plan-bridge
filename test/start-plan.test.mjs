import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as runtime from '../lib/zcode-runtime.js'

test('Start Plan uses only active, unexpired server entitlements and exact builtin model ids', () => {
  const payload = { code: 0, data: { server_time: 100, plans: [
    { status: 'active', starts_at: 10, ends_at: 200, entitlements: [
      { capabilities: ['model:glm-5.3'], effective_at: 10 },
      { capabilities: ['model:glm-5.3-flash', 'model:unknown'], effective_at: 10 },
      { capabilities: ['model:future'], effective_at: 150 },
    ] },
    { status: 'expired', ends_at: 90, entitlements: [{ capabilities: ['model:expired'] }] },
  ] } }
  assert.equal(typeof runtime.startPlanModelIds, 'function', 'Start Plan must resolve its own entitlements')
  assert.deepEqual(runtime.startPlanModelIds(payload, ['GLM-5.3', 'GLM-5.3-Flash', 'future', 'expired', 'glm-5.3']), ['GLM-5.3', 'GLM-5.3-Flash'])
})

test('Start Plan rejects failed or empty entitlement responses rather than using Coding Plan', () => {
  assert.equal(typeof runtime.startPlanModelIds, 'function')
  assert.throws(() => runtime.startPlanModelIds({ code: 1113 }, ['GLM-5.3']), /entitlement/i)
  assert.throws(() => runtime.startPlanModelIds({ code: 0, data: { plans: [] } }, ['GLM-5.3']), /entitlement/i)
})

test('host account snapshot binds to the exact builtin file and enables Start Plan only', () => {
  assert.equal(typeof runtime.startPlanAccountConfig, 'function')
  const snapshot = runtime.startPlanAccountConfig({ revision: 33, activeFilePath: 'C:/runtime/zcode-builtin.json' }, ['GLM-5.3'])
  assert.match(snapshot.basedOnZCodeBuiltinRevision, /^zcode-builtin:33:[a-f0-9]{64}$/)
  assert.deepEqual(Object.keys(snapshot.providers), ['account:zai-start-plan'])
  assert.deepEqual(snapshot.providers['account:zai-start-plan'].builtinModelIds, ['GLM-5.3'])
  assert.equal(snapshot.states['account:zai-start-plan'].current, true)
})
