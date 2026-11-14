import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import { toolkitHandler } from '../lib/toolkit-route.js'

async function host(t, admission) {
  const calls = []
  const runtime = { state: async () => ({ version: '0.6.2-test', scope: 'a'.repeat(64), settings: { revision: 'initial' } }), action: async value => { calls.push(value); return { state: 'applied' } } }
  const ctx = { get: () => admission === undefined ? undefined : { admit: () => admission } }
  const server = http.createServer((req, res) => { void toolkitHandler(ctx, runtime, 'test-key')(req, res) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}`
  return { url, calls, post: (body, headers = {}) => fetch(url, { method: 'POST', headers: { origin: url, 'content-type': 'application/json', 'x-zcode-toolkit-key': 'test-key', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }) }
}
const owner = { peer: { principal: { kind: 'owner' } } }
const action = { action: 'clear-cache', scope: 'a'.repeat(64), revision: 'initial' }
test('owner admission is mandatory even on loopback', async t => {
  for (const admission of [undefined, { rejection: 401 }, { peer: { principal: { kind: 'guest' } } }]) {
    const h = await host(t, admission)
    const response = await fetch(h.url)
    assert.ok([401, 403].includes(response.status))
    assert.equal(response.headers.get('cache-control'), 'no-store')
  }
})
test('owner can read and mutate only with exact origin, control key and closed bounded action', async t => {
  const h = await host(t, owner)
  const status = await fetch(h.url); assert.equal(status.status, 200); assert.equal((await status.json()).key, 'test-key')
  assert.equal((await h.post(action, { origin: 'https://attacker.example' })).status, 403)
  assert.equal((await h.post(action, { 'x-zcode-toolkit-key': 'wrong' })).status, 403)
  assert.equal((await h.post(action, { 'content-type': 'text/plain' })).status, 415)
  assert.equal((await h.post({ ...action, arbitrary: 'secret' })).status, 400)
  assert.equal((await h.post({ ...action, action: 'arbitrary-rpc' })).status, 400)
  assert.equal((await h.post(' '.repeat(16385))).status, 413)
  assert.equal((await h.post(action)).status, 200)
  assert.equal(h.calls.length, 1)
  assert.equal((await fetch(h.url, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403)
})
