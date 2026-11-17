import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import { toolkitHandler, registerToolkitRoute, TOOLKIT_PATH } from '../lib/toolkit-route.js'

async function host(t, admission) {
  const calls = []
  const runtime = { state: async () => ({ version: '0.6.2-test', scope: 'a'.repeat(64), settings: { revision: 'initial' } }), action: async value => { calls.push(value); return { state: 'applied' } } }
  const ctx = { get: () => admission === undefined ? undefined : { requestRejection: () => undefined, admit: () => admission } }
  const server = http.createServer((req, res) => { void toolkitHandler(ctx, runtime, 'test-key')(req, res) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}`
  return { url, calls, post: (body, headers = {}) => fetch(url, { method: 'POST', headers: { origin: url, 'content-type': 'application/json', 'x-zcode-toolkit-key': 'test-key', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }) }
}
const owner = { peer: { principal: { kind: 'owner' } } }
const action = { action: 'clear-cache', scope: 'a'.repeat(64), revision: 'initial' }

function registeredRoute(connection) {
  const routes = new Map()
  const effects = []
  const calls = []
  const scope = {
    get: name => { assert.equal(name, 'connection'); return connection },
    webServer: { register: route => {
      assert.equal(route.kind, 'exact')
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    } },
    effect: run => effects.push(run()),
  }
  registerToolkitRoute({ inject: (services, callback) => { assert.deepEqual(services, ['webServer', 'connection']); callback(scope) } }, {
    state: async () => { calls.push('state'); return {} },
    action: async value => { calls.push(value); return {} },
  })
  assert.deepEqual([...routes.keys()], [TOOLKIT_PATH])
  return { handler: routes.get(TOOLKIT_PATH), calls, dispose: () => effects.forEach(effect => effect()), routes }
}

function fakeRequest(method, headers = {}, body = action) {
  return {
    method, headers: { host: 'localhost:8765', ...headers }, socket: {}, bodyReads: 0,
    setTimeout() {},
    async *[Symbol.asyncIterator]() { this.bodyReads++; yield Buffer.from(JSON.stringify(body)) },
  }
}

function fakeResponse() {
  return { status: undefined, body: '', headers: {},
    setHeader(name, value) { this.headers[name] = value },
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers) },
    end(body) { this.body = body },
  }
}

test('registered route rejects host fence failures before owner admission, body reads or runtime work', async () => {
  for (const failure of [401, 403, null, false, true, 200, {}, Promise.resolve(undefined), 'rejected-promise', 'rejected-thenable', 'throw', 'missing', 'missing-service']) {
    let admitted = 0
    let checked = 0
    const connection = { admit() { admitted++; return owner }, requestRejection(req) {
      checked++
      assert.equal(req.headers.host, 'localhost:8765')
      if (failure === 'throw') throw new Error('host-unavailable')
      if (failure === 'rejected-promise') return Promise.reject(new Error('invalid-async-host'))
      if (failure === 'rejected-thenable') return { then(resolve, reject) { reject(new Error('invalid-thenable-host')) } }
      return failure
    } }
    if (failure === 'missing') delete connection.requestRejection
    const route = registeredRoute(failure === 'missing-service' ? undefined : connection)
    for (const method of ['GET', 'POST', 'DELETE']) {
      const req = fakeRequest(method)
      const res = fakeResponse()
      await route.handler(req, res)
      assert.equal(res.status, failure === 403 ? 403 : 401, `${String(failure)} ${method}`)
      assert.equal(req.bodyReads, 0)
      assert.equal(res.headers['Cache-Control'], 'no-store')
      assert.equal(JSON.parse(res.body).error, failure === 403 ? 'forbidden' : 'unauthorized')
    }
    assert.equal(checked, ['missing', 'missing-service'].includes(failure) ? 0 : 3)
    assert.equal(admitted, 0)
    assert.deepEqual(route.calls, [])
    await new Promise(resolve => setImmediate(resolve))
    route.dispose()
    assert.equal(route.routes.size, 0)
  }
})

test('host trust verdict is authoritative for hostile Host, Origin and Fetch Metadata', async () => {
  for (const headers of [{ host: 'attacker.invalid:8765' }, { host: 'attacker.invalid:8765', origin: 'http://attacker.invalid:8765' }, { origin: 'https://attacker.invalid' }, { 'sec-fetch-site': 'cross-site' }]) {
    let admitted = 0
    const route = registeredRoute({
      requestRejection(req) {
        return req.headers.host !== 'localhost:8765' || (req.headers.origin !== undefined && req.headers.origin !== 'http://localhost:8765') || req.headers['sec-fetch-site'] === 'cross-site' ? 403 : undefined
      },
      admit() { admitted++; return owner },
    })
    for (const method of ['GET', 'POST']) {
      const req = fakeRequest(method, headers)
      const res = fakeResponse()
      await route.handler(req, res)
      assert.equal(res.status, 403)
      assert.equal(req.bodyReads, 0)
    }
    assert.equal(admitted, 0)
    assert.deepEqual(route.calls, [])
    route.dispose()
  }
})

test('verified host pass preserves owner, method, control-key and Desktop forwarding requirements', async () => {
  const order = []
  const route = registeredRoute({ requestRejection() { order.push('fence'); return undefined }, admit() { order.push('owner'); return owner } })
  const read = fakeResponse()
  await route.handler(fakeRequest('GET'), read)
  assert.equal(read.status, 200)
  assert.deepEqual(order, ['fence', 'owner'])
  const key = JSON.parse(read.body).key
  const req = fakeRequest('POST', { 'content-type': 'application/json', 'x-zcode-toolkit-key': key })
  const write = fakeResponse()
  await route.handler(req, write)
  assert.equal(write.status, 200, 'verified authenticated Desktop forwarding may omit Origin')
  assert.equal(req.bodyReads, 1)
  assert.deepEqual(route.calls, ['state', action])
  for (const [method, headers, status] of [['DELETE', {}, 405], ['POST', {}, 403], ['POST', { 'x-zcode-toolkit-key': key, origin: 'https://attacker.invalid' }, 403]]) {
    const rejected = fakeRequest(method, headers)
    const res = fakeResponse()
    await route.handler(rejected, res)
    assert.equal(res.status, status)
    assert.equal(rejected.bodyReads, 0)
  }
  assert.deepEqual(route.calls, ['state', action])
  route.dispose()
  assert.equal(route.routes.size, 0)
})
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
  const forwarded = await fetch(h.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-zcode-toolkit-key': 'test-key' }, body: JSON.stringify(action) })
  assert.equal(forwarded.status, 200, 'authenticated Desktop forwarding strips Origin')
  assert.equal((await fetch(h.url, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403)
})
