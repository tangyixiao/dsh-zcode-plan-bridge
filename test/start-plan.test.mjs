import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as runtime from '../lib/zcode-runtime.js'
import * as startPlan from '../lib/start-plan.js'

// Derived from the 2026-11-01 read-only 3.17.1 balance probe: the observed
// response has both plan entitlement capabilities and an owner-matched balance.
// IDs and quota values are placeholders; clock is anchored to its HTTP Date.
const observedBalance = JSON.parse(fs.readFileSync(new URL('./fixtures/start-plan-balance-3.17.1.json', import.meta.url), 'utf8'))
const currentFixture = () => structuredClone(observedBalance)
const builtinIds = ['GLM-5.3-Flash', 'GLM-5.3']

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

test('the observed 3.17.1 balance shape resolves the actual authorized Flash model', () => {
  assert.deepEqual(runtime.startPlanModelIds(currentFixture(), builtinIds), ['GLM-5.3-Flash'])
})

test('balance capabilities are authoritative when plan entitlements omit capabilities', () => {
  const payload = currentFixture()
  delete payload.data.plans[0].entitlements[0].capabilities
  payload.data.balances[0].capabilities = [' MODEL:glm-5.3-flash ', 'model:unknown']
  assert.deepEqual(runtime.startPlanModelIds(payload, builtinIds), ['GLM-5.3-Flash'])
})

test('an empty current balance never falls back to old plan capability lists', () => {
  const payload = currentFixture()
  payload.data.balances = []
  assert.throws(() => runtime.startPlanModelIds(payload, builtinIds), /No active Start Plan model entitlements/)
})

test('show_name fallback stays restricted to owner-matched active balances and known builtin IDs', () => {
  const payload = currentFixture()
  payload.data.balances[0].capabilities = []
  payload.data.balances[0].show_name = ' glm-5.3-FLASH '
  assert.deepEqual(runtime.startPlanModelIds(payload, builtinIds), ['GLM-5.3-Flash'])
  payload.data.balances[0].show_name = 'unknown'
  assert.throws(() => runtime.startPlanModelIds(payload, builtinIds), /No active Start Plan model entitlements/)
})

test('active status is normalized and zero expiry is a non-expiring sentinel', () => {
  const payload = currentFixture()
  payload.data.plans[0].status = ' ACTIVE '
  payload.data.plans[0].ends_at = 0
  payload.data.balances[0].expires_at = 0
  assert.deepEqual(runtime.startPlanModelIds(payload, builtinIds), ['GLM-5.3-Flash'])
})

for (const [name, mutate] of [
  ['expired plan', p => { p.data.plans[0].status = 'expired' }],
  ['pending plan', p => { p.data.plans[0].status = 'pending' }],
  ['future plan', p => { p.data.plans[0].starts_at = p.data.server_time + 1 }],
  ['expired plan timestamp', p => { p.data.plans[0].ends_at = p.data.server_time }],
  ['future grant', p => { p.data.plans[0].entitlements[0].effective_at = p.data.server_time + 1 }],
  ['future bucket', p => { p.data.balances[0].period_start = p.data.server_time + 1 }],
  ['expired bucket', p => { p.data.balances[0].expires_at = p.data.server_time }],
  ['ended bucket period', p => { p.data.balances[0].period_end = p.data.server_time }],
  ['wrong user plan instance', p => { p.data.balances[0].user_plan_id = 'another-instance' }],
  ['wrong plan', p => { p.data.balances[0].plan_id = 'another-plan' }],
  ['wrong entitlement', p => { p.data.balances[0].entitlement_id = 'another-grant' }],
  ['unknown authorized model', p => { p.data.balances[0].capabilities = ['model:not-in-builtin'] }],
]) test(`Start Plan rejects ${name} instead of using stale or unrelated grants`, () => {
  const payload = currentFixture()
  mutate(payload)
  assert.throws(() => runtime.startPlanModelIds(payload, builtinIds), /No active Start Plan model entitlements/)
})

test('HTTP response time overrides a stale JSON clock for expiry', () => {
  const payload = currentFixture()
  assert.throws(() => runtime.startPlanModelIds(payload, builtinIds, { responseTime: 1793581201 }), /No active Start Plan model entitlements/)
})

function requestFixture(t, deviceMid = 'fixture-device-mid') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-start-plan-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const root = path.join(directory, '.zcode', 'v2')
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'credentials.json'), JSON.stringify({ zcodejwttoken: 'fixture-jwt-never-a-real-credential', 'oauth:active_provider': 'zai' }))
  if (deviceMid !== undefined) fs.writeFileSync(path.join(root, 'telemetry-state.json'), JSON.stringify({ deviceMid }))
  const activeFilePath = path.join(directory, 'zcode-builtin.json')
  fs.writeFileSync(activeFilePath, JSON.stringify({ config: { providerConfigRules: { providerRules: [{ config: { builtinModelIds: builtinIds } }], templateRules: [] } } }))
  return { directory, root, builtin: { version: '3.17.1', activeFilePath, revision: 43 } }
}

test('queries balance exactly once with the real app version and existing device header, without changing files', async t => {
  assert.equal(typeof startPlan.fetchStartPlanModels, 'function')
  const { directory, root, builtin } = requestFixture(t)
  const before = fs.readFileSync(path.join(root, 'telemetry-state.json'))
  let calls = 0
  const models = await startPlan.fetchStartPlanModels(builtin, directory, async (url, options) => {
    calls++
    assert.equal(url, 'https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=3.17.1')
    assert.equal(options.headers['X-Device-Mid'], 'fixture-device-mid')
    assert.equal(options.headers.authorization, 'Bearer fixture-jwt-never-a-real-credential')
    assert.equal(options.redirect, 'error')
    assert.equal(options.credentials, 'omit')
    return Response.json(currentFixture(), { headers: { date: 'Sun, 01 Nov 2026 06:48:46 GMT' } })
  })
  assert.deepEqual(models, ['GLM-5.3-Flash'])
  assert.equal(calls, 1)
  assert.deepEqual(fs.readFileSync(path.join(root, 'telemetry-state.json')), before)
  assert.ok(!fs.existsSync(path.join(directory, '.dsh')), 'read-only entitlement discovery must not create provider configuration')
})

test('missing or invalid existing device IDs fail before an authenticated request and are never generated', async t => {
  assert.equal(typeof startPlan.fetchStartPlanModels, 'function')
  for (const deviceMid of ['', 'bad\r\nheader', 'unicode-设备']) {
    const { directory, root, builtin } = requestFixture(t, deviceMid)
    const before = fs.readFileSync(path.join(root, 'telemetry-state.json'))
    let calls = 0
    await assert.rejects(startPlan.fetchStartPlanModels(builtin, directory, async () => { calls++; throw Error('must not fetch') }), /device identifier/i)
    assert.equal(calls, 0)
    assert.deepEqual(fs.readFileSync(path.join(root, 'telemetry-state.json')), before)
  }
  const { directory, root, builtin } = requestFixture(t)
  fs.unlinkSync(path.join(root, 'telemetry-state.json'))
  await assert.rejects(startPlan.fetchStartPlanModels(builtin, directory, async () => { throw Error('must not fetch') }), /device identifier/i)
  assert.ok(!fs.existsSync(path.join(root, 'telemetry-state.json')))
})

test('balance transport failure is distinct from a successful response without usable entitlements', async t => {
  assert.equal(typeof startPlan.fetchStartPlanModels, 'function')
  const { directory, builtin } = requestFixture(t)
  await assert.rejects(startPlan.fetchStartPlanModels(builtin, directory, async () => new Response('', { status: 503 })), /balance request.*503/i)
  await assert.rejects(startPlan.fetchStartPlanModels(builtin, directory, async () => Response.json({ code: 0, data: { plans: [], balances: [] } })), /No active Start Plan model entitlements/)
})
