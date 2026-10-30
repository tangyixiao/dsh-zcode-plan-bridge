import assert from 'node:assert/strict'
import test from 'node:test'

import { ZcodeAppServerAdapter } from '../lib/app-server.js'

const firstMessages = [{ role: 'user', content: [{ type: 'text', text: 'first prompt' }] }]
const nextMessages = [...firstMessages, { role: 'assistant', content: [{ type: 'text', text: 'partial reply' }] },
  { role: 'user', content: [{ type: 'text', text: 'next prompt' }] }]

async function flush() {
  for (let i = 0; i < 30; i += 1) await Promise.resolve()
}

/** Keep the real request/parser/dispatch path; replace only the external CLI process. */
function harness(t, { holdSend = false, holdStop = false, failStop = false, seed = true, holdMethods = [], rejectFirstSend = false } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const options = {
    zcodeCliTimeoutMs: 900000, appServerTimeoutMs: 120000,
    authorizationPolicy: 'deny', cliModels: [], cliCwd: '',
  }
  const adapter = new ZcodeAppServerAdapter({ options: () => options })
  adapter.catalog = []
  if (seed) adapter.sessions.set('conversation', {
    sessionId: 'old-session', firstTurn: true, providerId: 'zai-api',
    modelId: 'GLM-5.3', authorizationPolicy: 'deny',
  })
  const outbound = []
  const held = new Map()
  let created = 0
  const receive = (message) => adapter.client.onData(JSON.stringify(message) + '\n')
  const reply = (request, error = false) => {
    let result = {}
    if (request.method === 'session/create') {
      result = { session: { sessionId: `new-session-${++created}`, model: { providerId: 'zai-api', modelId: 'GLM-5.3' } } }
    }
    receive(error ? { id: request.id, error: { message: 'stop rejected' } } : { id: request.id, result })
  }
  adapter.client.child = {
    stdin: { write(line) {
      const request = JSON.parse(line)
      outbound.push(request)
      // The installed CLI ignores session/stop notifications: only requests get replies.
      if (request.id === undefined) return true
      if (request.method === 'session/send' && rejectFirstSend) {
        rejectFirstSend = false
        queueMicrotask(() => receive({ id: request.id, error: { message: 'A prompt is already running for this session' } }))
      } else if ((request.method === 'session/send' && holdSend) || (request.method === 'session/stop' && holdStop) || holdMethods.includes(request.method)) {
        held.set(request.id, request)
      } else queueMicrotask(() => reply(request, request.method === 'session/stop' && failStop))
      return true
    } },
    kill() {},
  }
  const event = (sessionId, type, payload) => receive({ method: 'session/event', params: { sessionId, type, payload } })
  const requests = (method) => outbound.filter((message) => message.method === method)
  const acknowledge = (method, error = false, sessionId) => {
    for (const [id, request] of held) if (request.method === method && (sessionId === undefined || request.params.sessionId === sessionId)) {
      held.delete(id)
      reply(request, error)
    }
  }
  const start = (signal, messages = firstMessages) => {
    const stream = adapter.stream({ model: 'GLM-5.3', sessionId: 'conversation', messages, signal })
    const pending = stream.next()
    return { stream, pending }
  }
  const tick = async (ms = 1500) => { t.mock.timers.tick(ms); await flush() }
  t.after(() => {
    acknowledge('session/send')
    acknowledge('session/stop')
    adapter.dispose()
    for (const { reject } of adapter.client.pending.values()) reject(new Error('test cleanup'))
    adapter.client.pending.clear()
  })
  return { adapter, start, event, requests, acknowledge, tick, outbound }
}

async function firstDelta(h, turn) {
  await flush()
  await h.tick()
  const sessionId = h.requests('session/send').at(-1).params.sessionId
  h.event(sessionId, 'model.streaming', { kind: 'text_delta', delta: 'partial reply' })
  await flush()
  assert.equal((await turn.pending).value.type, 'block-start')
  assert.equal((await turn.stream.next()).value.type, 'text-delta')
  return sessionId
}

test('abort stops the upstream turn and frees local state while the consumer is paused at a delta', async (t) => {
  const h = harness(t)
  const controller = new AbortController()
  const turn = h.start(controller.signal)
  await firstDelta(h, turn)

  // Deliberately never call next() or return(): abort must work independently of pulling.
  controller.abort()
  await flush()
  assert.equal(h.requests('session/stop').length, 1)
  assert.equal(typeof h.requests('session/stop')[0].id, 'number', 'stop must be an acknowledged RPC request')
  assert.equal(h.adapter.activeStreams.size, 0)
  assert.equal(h.adapter.client.listeners.size, 0)
  assert.equal(h.adapter.turnLocks.size, 0)

  const followup = h.start(undefined, nextMessages)
  await flush()
  await h.tick()
  await h.tick()
  assert.equal(h.requests('session/send').length, 2, 'follow-up must not wait for the 60-second queue cap')
  h.event(h.requests('session/send').at(-1).params.sessionId, 'turn.completed', { response: '', resultType: 'success' })
  await followup.pending
  await followup.stream.return()
})

test('a pending stop keeps the next prompt queued until the CLI acknowledges it', async (t) => {
  const h = harness(t, { holdStop: true })
  const controller = new AbortController()
  const turn = h.start(controller.signal)
  await firstDelta(h, turn)
  controller.abort()
  await flush()
  const followup = h.start(undefined, nextMessages)
  await flush()
  assert.equal(h.requests('session/stop').length, 1)
  assert.equal(h.requests('session/send').length, 1)
  h.acknowledge('session/stop')
  await flush()
  await h.tick()
  await h.tick()
  assert.equal(h.requests('session/send').length, 2)
  h.event(h.requests('session/send').at(-1).params.sessionId, 'turn.completed', { response: '', resultType: 'success' })
  await followup.pending
  await followup.stream.return()
})

test('returning an aborted generator later cannot stop the replacement turn', async (t) => {
  const h = harness(t)
  const controller = new AbortController()
  const turn = h.start(controller.signal)
  await firstDelta(h, turn)
  controller.abort()
  await flush()
  const followup = h.start(undefined, nextMessages)
  await flush()
  await h.tick()
  await h.tick()
  assert.equal(h.requests('session/send').length, 2)
  await turn.stream.return()
  assert.equal(h.requests('session/stop').length, 1)
  assert.equal(h.adapter.activeStreams.size, 1)
  h.event(h.requests('session/send').at(-1).params.sessionId, 'turn.completed', { response: '', resultType: 'success' })
  await followup.pending
  await followup.stream.return()
})

test('a pre-aborted turn never sends a prompt or stops a different turn', async (t) => {
  const h = harness(t)
  const controller = new AbortController()
  controller.abort()
  const turn = h.start(controller.signal)
  const rejection = assert.rejects(turn.pending, { code: 'ABORTED' })
  await flush()
  await h.tick()
  await rejection
  assert.equal(h.requests('session/send').length, 0)
  assert.equal(h.requests('session/stop').length, 0)
  assert.equal(h.adapter.turnLocks.size, 0)
})

test('abort during the pre-send setup delay prevents a late session/send', async (t) => {
  const h = harness(t)
  const controller = new AbortController()
  const turn = h.start(controller.signal)
  const rejection = assert.rejects(turn.pending, { code: 'ABORTED' })
  await flush()
  controller.abort()
  await flush()
  await h.tick()
  await rejection
  assert.equal(h.requests('session/send').length, 0)
  assert.equal(h.requests('session/stop').length, 0)
  assert.equal(h.adapter.activeStreams.size, 0)
  assert.equal(h.adapter.turnLocks.size, 0)
})

test('abort while session/send is awaiting its reply sends stop immediately and never retries the prompt', async (t) => {
  const h = harness(t, { holdSend: true, holdStop: true })
  const controller = new AbortController()
  const turn = h.start(controller.signal)
  const rejection = assert.rejects(turn.pending, { code: 'ABORTED' })
  await flush()
  await h.tick()
  assert.equal(h.requests('session/send').length, 1)
  controller.abort()
  await flush()
  assert.equal(h.requests('session/stop').length, 1)
  assert.equal(h.adapter.activeStreams.size, 0)
  h.acknowledge('session/send')
  h.acknowledge('session/stop')
  await flush()
  await rejection
  assert.equal(h.requests('session/send').length, 1)
  assert.equal(h.adapter.turnLocks.size, 0)
})

test('failed stop evicts the cached session before releasing its local gate', async (t) => {
  const h = harness(t, { failStop: true })
  const controller = new AbortController()
  const turn = h.start(controller.signal)
  await firstDelta(h, turn)
  controller.abort()
  await flush()
  assert.equal(h.requests('session/stop').length, 1)
  assert.equal(h.adapter.sessions.has('conversation'), false)
  assert.equal(h.adapter.activeStreams.size, 0)
  assert.equal(h.adapter.client.listeners.size, 0)
  assert.equal(h.adapter.turnLocks.size, 0)
})

test('a successful turn completed while paused never sends a redundant stop', async (t) => {
  const h = harness(t)
  const controller = new AbortController()
  const turn = h.start(controller.signal)
  await firstDelta(h, turn)
  h.event('old-session', 'turn.completed', { response: 'partial reply', resultType: 'success' })
  controller.abort()
  await flush()
  await turn.stream.return()
  assert.equal(h.requests('session/stop').length, 0)
  assert.equal(h.adapter.activeStreams.size, 0)
  assert.equal(h.adapter.turnLocks.size, 0)
})

test('abort wakes an idle consumer waiting for its next chunk', async (t) => {
  const h = harness(t)
  const controller = new AbortController()
  const turn = h.start(controller.signal)
  const rejection = assert.rejects(turn.pending, { code: 'ABORTED' })
  await flush()
  await h.tick()
  controller.abort()
  await flush()
  await rejection
  assert.equal(h.requests('session/stop').length, 1)
  assert.equal(h.adapter.activeStreams.size, 0)
  assert.equal(h.adapter.client.listeners.size, 0)
  assert.equal(h.adapter.turnLocks.size, 0)
})

test('canceling a queued prompt cannot stop the active prompt or send later', async (t) => {
  const h = harness(t)
  const firstController = new AbortController()
  const first = h.start(firstController.signal)
  await firstDelta(h, first)
  const queuedController = new AbortController()
  const queued = h.start(queuedController.signal, nextMessages)
  const rejection = assert.rejects(queued.pending, { code: 'ABORTED' })
  await flush()
  queuedController.abort()
  await flush()
  await rejection
  assert.equal(h.requests('session/send').length, 1)
  assert.equal(h.requests('session/stop').length, 0)
  assert.equal(h.adapter.activeStreams.size, 1)
  firstController.abort()
  await flush()
  await h.tick(60000)
  assert.equal(h.requests('session/send').length, 1)
  assert.equal(h.requests('session/stop').length, 1)
  assert.equal(h.adapter.turnLocks.size, 0)
})

test('abort during session creation cannot install a stale session or send after setup responds', async (t) => {
  const h = harness(t, { seed: false, holdMethods: ['session/create'] })
  const controller = new AbortController()
  const turn = h.start(controller.signal)
  const rejection = assert.rejects(turn.pending, { code: 'ABORTED' })
  await flush()
  assert.equal(h.requests('session/create').length, 1)
  controller.abort()
  await flush()
  assert.equal(h.adapter.turnLocks.size, 0)
  h.acknowledge('session/create')
  await flush()
  await rejection
  assert.equal(h.requests('session/subscribe').length, 0)
  assert.equal(h.requests('session/send').length, 0)
  assert.equal(h.requests('session/stop').length, 0)
  assert.equal(h.adapter.sessions.size, 0)
})

test('unacknowledged stop is bounded and evicts its session before allowing another prompt', async (t) => {
  const h = harness(t, { holdStop: true })
  const controller = new AbortController()
  const turn = h.start(controller.signal)
  await firstDelta(h, turn)
  controller.abort()
  await flush()
  await h.tick(4999)
  assert.equal(h.adapter.turnLocks.size, 1)
  assert.equal(h.adapter.sessions.has('conversation'), true)
  await h.tick(1)
  assert.equal(h.adapter.turnLocks.size, 0)
  assert.equal(h.adapter.sessions.has('conversation'), false)
  assert.equal(h.adapter.client.pending.size, 0)
  assert.equal(h.requests('session/stop').length, 1)
})

test('a late session/send reply after cancellation cannot reuse or stop the replacement session', async (t) => {
  const h = harness(t, { holdSend: true })
  const controller = new AbortController()
  const turn = h.start(controller.signal)
  const rejection = assert.rejects(turn.pending, { code: 'ABORTED' })
  await flush()
  await h.tick()
  controller.abort()
  await flush()
  assert.equal(h.adapter.sessions.has('conversation'), false)
  const followup = h.start(undefined, nextMessages)
  await flush()
  await h.tick()
  await h.tick()
  assert.equal(h.requests('session/send').length, 2)
  assert.equal(h.requests('session/send')[1].params.sessionId, 'new-session-1')
  h.acknowledge('session/send')
  await flush()
  await rejection
  await turn.stream.return()
  assert.equal(h.requests('session/stop').length, 2)
  assert.equal(h.adapter.sessions.get('conversation').sessionId, 'new-session-1')
  assert.equal(h.adapter.activeStreams.size, 1)
  h.event('new-session-1', 'turn.completed', { response: '', resultType: 'success' })
  await followup.pending
  await followup.stream.return()
})

test('stuck-turn recovery waits for stop acknowledgement before rebuilding and replaying the prompt', async (t) => {
  const h = harness(t, { holdStop: true, rejectFirstSend: true })
  const turn = h.start()
  await flush()
  await h.tick()
  assert.equal(h.requests('session/stop').length, 1)
  await h.tick(1500)
  assert.equal(h.requests('session/send').length, 1)
  h.acknowledge('session/stop')
  await flush()
  await h.tick(1500)
  await h.tick(1500)
  assert.equal(h.requests('session/send').length, 2)
  h.event(h.requests('session/send').at(-1).params.sessionId, 'turn.completed', { response: '', resultType: 'success' })
  await turn.pending
  await turn.stream.return()
  assert.equal(h.requests('session/stop').length, 1)
})

test('abort rejects the pending pull before session/send replies and stops that old send again after its late reply', async (t) => {
  const h = harness(t, { holdSend: true })
  const controller = new AbortController()
  const turn = h.start(controller.signal)
  let abortedError
  const observed = turn.pending.catch((error) => { abortedError = error })
  await flush()
  await h.tick()
  controller.abort()
  await flush()
  assert.equal(abortedError?.code, 'ABORTED', 'canceling must not wait for the original send RPC timeout')
  assert.equal(h.requests('session/stop').length, 1)
  assert.equal(h.adapter.turnLocks.size, 0)

  const followup = h.start(undefined, nextMessages)
  await flush()
  await h.tick()
  await h.tick()
  assert.equal(h.requests('session/send').length, 2)
  h.acknowledge('session/send', false, 'old-session')
  await flush()
  assert.deepEqual(h.requests('session/stop').map((request) => request.params.sessionId), ['old-session', 'old-session'])
  assert.equal(h.adapter.sessions.get('conversation').sessionId, 'new-session-1')
  assert.equal(h.adapter.activeStreams.size, 1)
  await observed
  await turn.stream.return()
  assert.equal(h.requests('session/stop').length, 2, 'late generator cleanup must not stop the new session')
  h.acknowledge('session/send', false, 'new-session-1')
  h.event('new-session-1', 'turn.completed', { response: '', resultType: 'success' })
  await followup.pending
  await followup.stream.return()
})

test('abort rejects a pending setup pull without waiting for session creation to respond', async (t) => {
  const h = harness(t, { seed: false, holdMethods: ['session/create'] })
  const controller = new AbortController()
  const turn = h.start(controller.signal)
  let abortedError
  const observed = turn.pending.catch((error) => { abortedError = error })
  await flush()
  controller.abort()
  await flush()
  assert.equal(abortedError?.code, 'ABORTED')
  assert.equal(h.adapter.turnLocks.size, 0)
  h.acknowledge('session/create')
  await flush()
  await observed
  assert.equal(h.requests('session/send').length, 0)
  assert.equal(h.adapter.sessions.size, 0)
})

test('abort during a resumed model switch cannot reattach cleaned-up stream listeners', async (t) => {
  const h = harness(t, { holdMethods: ['session/setModel'] })
  const first = h.start()
  await firstDelta(h, first)
  h.event('old-session', 'turn.completed', { response: 'partial reply', resultType: 'success' })
  await first.stream.return()
  h.adapter.catalog = [{
    providerId: 'alternate-provider', modelId: 'GLM-5.3', label: 'GLM-5.3',
    providerLabel: 'Alternate route', contextWindow: 200000, maxOutputTokens: 10000,
    reasoningLevels: ['high'], defaultReasoningLevel: 'high', supportsImage: false,
  }]

  const controller = new AbortController()
  const next = h.start(controller.signal, nextMessages)
  let abortedError
  const observed = next.pending.catch((error) => { abortedError = error })
  await flush()
  assert.equal(h.requests('session/setModel').length, 1)
  controller.abort()
  await flush()
  assert.equal(abortedError?.code, 'ABORTED')
  assert.equal(h.adapter.activeStreams.size, 0)
  assert.equal(h.adapter.client.listeners.size, 0)
  assert.equal(h.requests('session/send').length, 1)
  h.acknowledge('session/setModel')
  await observed
})
