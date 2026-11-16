import assert from 'node:assert/strict'
import test from 'node:test'
import { ZSwitchClient, projectState, projectQuota } from '../lib/zswitch.js'

const raw = () => ({ ok: true, active_account_id: 'one', live_hash: 'private-hash', zcode_running: true, store_dir: '/private/home/.zcode-switch', accounts: [
  { id: 'one', name: 'Account A', updated_at: 'now', jwt_expired: false, identity: { provider: 'bigmodel', email: 'private@example.com', user_id: 'private-id' }, credentials: 'SECRET' },
  { id: 'two', name: 'Account B', updated_at: 'later', identity: { provider: 'zai' } },
], auth_proxy_url: 'SECRET' })

test('owner account summaries are explicitly projected and revisions track source changes', () => {
  const state = projectState(raw())
  assert.equal(state.accounts.length, 2)
  assert.equal(state.activeId, 'one')
  assert.equal(state.accounts[0].provider, 'bigmodel')
  assert.doesNotMatch(JSON.stringify(state), /SECRET|private@example|private-id|private-hash|private\/home/)
  const changed = raw(); changed.accounts[0].updated_at = 'new'
  assert.notEqual(projectState(changed).revision, state.revision)
})
test('malformed library state fails closed, including duplicate IDs and traversal', () => {
  for (const change of [r => r.accounts.push(r.accounts[0]), r => r.accounts[0].id = '../x', r => r.active_account_id = 'absent', r => r.accounts = null]) {
    const value = raw(); change(value); assert.throws(() => projectState(value), /zswitch-invalid-state/)
  }
})
test('manual switching delegates exact non-killing flags, never shell commands or raw errors', async () => {
  const calls = []
  const client = new ZSwitchClient({ path: '/installed/zcode-switch', run: async (file, args, opts) => { calls.push({ file, args, opts }); return { stdout: JSON.stringify({ ok: true, switched: true, probe: { kind: 'entitled', models: ['GLM-5.3-Flash'] }, secret: 'SECRET' }) } } })
  const result = await client.command('switch', { id: 'one' })
  assert.deepEqual(calls[0].args, ['--cli', 'switch', '--id', 'one', '--no-restart', '--hot', 'true'])
  assert.equal(calls[0].opts.windowsHide, true)
  assert.equal(calls[0].opts.shell, false)
  assert.ok(calls[0].opts.timeout <= 60000)
  assert.ok(calls[0].opts.maxBuffer <= 1048576)
  assert.equal(result.switched, true)
  assert.doesNotMatch(JSON.stringify(result), /SECRET/)
  await assert.rejects(client.command('kill', {}), /zswitch-invalid-action/)
  await assert.rejects(client.command('delete', { id: '../x' }), /zswitch-invalid-action/)
  await assert.rejects(client.command('switch', { id: '--force' }), /zswitch-invalid-action/)
  await assert.rejects(client.command('capture', { name: '--lang' }), /zswitch-invalid-action/)
})
test('process and JSON failures expose fixed error codes only', async () => {
  for (const run of [async () => { throw new Error('token SECRET /private/file') }, async () => ({ stdout: '{bad SECRET' }), async () => ({ stdout: JSON.stringify({ ok: false, error: 'SECRET' }) })]) {
    const client = new ZSwitchClient({ path: '/installed/zcode-switch', run })
    await assert.rejects(client.state(), error => error.message === 'zswitch-unavailable' && !JSON.stringify(error).includes('SECRET'))
  }
})
test('quota projection preserves zero and unknown without returning arbitrary upstream fields', () => {
  const value = projectQuota({ ok: true, remaining: 0, used: 2, total: 2, items: [{ name: 'Plan', remaining: 0, unit: 'tokens', secret: 'SECRET' }], secret: 'SECRET' })
  assert.equal(value.remaining, 0)
  assert.equal(value.items[0].total, undefined)
  assert.doesNotMatch(JSON.stringify(value), /SECRET/)
})
