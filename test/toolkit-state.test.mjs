import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ToolkitSettingsStore, accountScope, ObservationLog, classifyFailure } from '../lib/toolkit-state.js'
import { localStatus, shareableStatus } from '../lib/toolkit-diagnostics.js'
import { sanitizePlanBalance } from '../lib/start-plan.js'

const scratch = fileURLToPath(new URL('../../work/zcode-toolkit-20261114/', import.meta.url))
function fixture(t) {
  fs.mkdirSync(scratch, { recursive: true })
  const dir = fs.mkdtempSync(path.join(scratch, 'state-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
const scope = 'a'.repeat(64)
test('settings are revisioned, closed, durable and isolated per scope', t => {
  const dir = fixture(t); const store = new ToolkitSettingsStore(path.join(dir, 'toolkit.json'))
  const initial = store.read(scope)
  const next = store.update(scope, initial.revision, { hiddenModels: ['glm'], reasoning: { glm: 'high' } })
  assert.notEqual(next.revision, initial.revision)
  assert.deepEqual(new ToolkitSettingsStore(store.file).read(scope), next)
  assert.deepEqual(store.read('b'.repeat(64)).hiddenModels, [])
  assert.throws(() => store.update(scope, initial.revision, {}), /stale-state/)
  assert.throws(() => store.update(scope, next.revision, { authorizationPolicy: 'shell' }), /invalid-settings/)
  assert.throws(() => store.update(scope, next.revision, { arbitrary: true }), /invalid-settings/)
  assert.throws(() => store.update(scope, next.revision, { retry: { enabled: true, intervalMs: -1 } }), /invalid-settings/)
  fs.writeFileSync(store.file + '.lock', '')
  assert.throws(() => store.update(scope, next.revision, {}), /storage-busy/)
})
test('credential generations and channel changes receive different opaque scopes', t => {
  const dir = fixture(t); fs.mkdirSync(path.join(dir, '.zcode/v2'), { recursive: true })
  const file = path.join(dir, '.zcode/v2/credentials.json')
  fs.writeFileSync(file, JSON.stringify({ zcodejwttoken: 'private-A', 'oauth:active_provider': 'zai' }))
  const options = { zcodeDataBaseDir: dir, accountMode: 'standalone' }
  const a = accountScope(options)
  assert.match(a, /^[a-f0-9]{64}$/)
  assert.notEqual(a, accountScope({ ...options, accountMode: 'start-plan' }))
  fs.writeFileSync(file, JSON.stringify({ zcodejwttoken: 'private-B', 'oauth:active_provider': 'zai' }))
  assert.notEqual(a, accountScope(options))
})
test('bounded observations keep unknown and observed zero distinct and drop private fields', () => {
  const log = new ObservationLog(2)
  log.record(scope, { model: 'glm', result: 'success', prompt: 'secret', usage: undefined })
  assert.equal(log.read(scope)[0].usage, undefined)
  log.record(scope, { model: 'glm', result: 'success', usage: { inputTokens: 0, outputTokens: 0, credit: 0 } })
  assert.deepEqual(log.read(scope)[0].usage, { inputTokens: 0, outputTokens: 0 })
  log.record('other', { result: 'failure', error: new Error('HTTP 405 secret-path') })
  assert.equal(log.read(scope).length, 1)
  assert.equal(log.read('other')[0].category, 'channel')
  assert.doesNotMatch(JSON.stringify(log.read(scope)), /secret|prompt|credit/)
})
test('failure categories preserve auth, channel and cancellation boundaries', () => {
  assert.equal(classifyFailure({ code: 'ABORTED' }), 'cancelled')
  assert.equal(classifyFailure({ code: 'TIMEOUT' }), 'timeout')
  assert.equal(classifyFailure(new Error('HTTP 401')), 'authentication')
  assert.equal(classifyFailure(new Error('Start Plan mode requires a signed-in Z.AI or BigModel account')), 'authentication')
  assert.equal(classifyFailure(new Error('HTTP 405 ESA request blocked')), 'channel')
  assert.equal(classifyFailure(new Error('HTTP 402 insufficient balance')), 'quota')
  assert.equal(classifyFailure(new Error('HTTP 429')), 'throttled')
})
test('shareable reports are allowlisted and never start a CLI or leak local identity', t => {
  const dir = fixture(t)
  const status = localStatus({ zcodeDataBaseDir: dir, zcodeCliPath: path.join(dir, 'private-cli.cjs'), accountMode: 'start-plan' })
  const report = shareableStatus({ ...status, arbitrary: 'secret-token', path: dir })
  assert.equal(report.inference, 'not-tested')
  assert.equal(report.accountMode, 'start-plan')
  assert.doesNotMatch(JSON.stringify(report), /secret-token|private-cli|state-|arbitrary|scope/)
})
test('plan projection keeps authoritative units and strips identifiers and unknown fields', () => {
  const payload = JSON.parse(fs.readFileSync(new URL('./fixtures/start-plan-balance-3.17.1.json', import.meta.url)))
  const projected = sanitizePlanBalance(payload, 1234)
  assert.equal(projected.observedAt, 1234)
  assert.equal(projected.balances[0].remainingUnits, 1)
  assert.equal(projected.balances[0].unitType, 'tokens')
  assert.doesNotMatch(JSON.stringify(projected), /user-plan|plan-redacted|bucket_id|entitlement_id/)
  assert.equal(sanitizePlanBalance({ data: { balances: [{ remaining_units: -1 }] } }, 1).balances[0].remainingUnits, undefined)
})
