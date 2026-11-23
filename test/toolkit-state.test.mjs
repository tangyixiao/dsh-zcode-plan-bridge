import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ToolkitSettingsStore, accountScope, ObservationLog, classifyFailure } from '../lib/toolkit-state.js'
import { localStatus, shareableStatus } from '../lib/toolkit-diagnostics.js'

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
test('local status and scope use only native login file metadata and channel', t => {
  const dir = fixture(t); fs.mkdirSync(path.join(dir, '.zcode/v2'), { recursive: true })
  const file = path.join(dir, '.zcode/v2/credentials.json')
  fs.writeFileSync(file, 'unreadable-as-JSON')
  const read = fs.readFileSync
  t.mock.method(fs, 'readFileSync', function (target, ...args) {
    assert.notEqual(target, file, 'status and account scoping must not open a native login file')
    return read.call(fs, target, ...args)
  })
  const open = fs.openSync
  t.mock.method(fs, 'openSync', function (target, ...args) {
    assert.notEqual(target, file, 'status and account scoping must not open a native login file')
    return open.call(fs, target, ...args)
  })
  const options = { zcodeDataBaseDir: dir, accountMode: 'standalone' }
  const a = accountScope(options)
  assert.match(a, /^[a-f0-9]{64}$/)
  assert.notEqual(a, accountScope({ ...options, accountMode: 'start-plan' }))
  assert.equal(localStatus(options).credentials, 'present')
  assert.equal(shareableStatus(localStatus(options)).credentials, 'present')
  const managed = { ...options, managedAccount: { id: 'one', generation: 'first-login' } }
  const signedIn = accountScope(managed)
  fs.utimesSync(file, new Date(10000), new Date(10000))
  assert.equal(accountScope(managed), signedIn)
  assert.notEqual(accountScope({ ...managed, managedAccount: { id: 'one', generation: 'second-login' } }), signedIn)
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
