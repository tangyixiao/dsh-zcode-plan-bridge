import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'

import { ZcodeAppServerAdapter } from '../lib/app-server.js'
import { resolveOptions } from '../lib/index.js'

function harness(t, stuck = false) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const adapter = new ZcodeAppServerAdapter({ options: () => resolveOptions({}) })
  let sessions = 0
  const frames = []
  adapter.ensureSession = async (key) => {
    let session = adapter.sessions.get(key)
    if (!session) {
      session = { sessionId: `s${++sessions}`, firstTurn: true, providerId: 'plan', modelId: 'test' }
      adapter.sessions.set(key, session)
    }
    return session
  }
  adapter.resolveRoute = async () => undefined
  const event = (sessionId, type, payload) => adapter.client.onData(JSON.stringify({
    method: 'session/event', params: { sessionId, type, payload },
  }) + '\n')
  adapter.client.write = (message) => {
    frames.push(message)
    if (stuck && message.method === 'session/send' && message.params.sessionId === 's1') {
      adapter.client.onData(JSON.stringify({ id: message.id, error: { message: 'A prompt is already running' } }) + '\n')
    } else adapter.client.onData(JSON.stringify({ id: message.id, result: {} }) + '\n')
    if (stuck && message.method === 'session/stop') {
      event('s1', 'model.streaming', { kind: 'text_delta', delta: 'stale old response' })
      event('s1', 'turn.completed', { response: 'stale old response', resultType: 'success' })
    }
  }
  const start = (signal, content) => {
    const stream = adapter.stream({ model: 'test', sessionId: 'dsh', messages: [{ role: 'user', content: [{ type: 'text', text: content }] }], signal })
    return { stream, pending: stream.next() }
  }
  const tick = async () => { await setImmediate(); t.mock.timers.tick(1500); await setImmediate() }
  return { adapter, frames, event, start, tick }
}

test('a canceled turn cannot finish its replacement with a late terminal event', async (t) => {
  const h = harness(t)
  const controller = new AbortController()
  const first = h.start(controller.signal, 'first')
  await h.tick()
  h.event('s1', 'model.streaming', { kind: 'text_delta', delta: 'first partial' })
  await first.pending
  await first.stream.next()
  controller.abort()
  await setImmediate()
  assert.equal(h.adapter.sessions.has('dsh'), false, 'stop acknowledgement does not mean the old turn has terminated')

  const second = h.start(undefined, 'second')
  let secondYielded = false
  void second.pending.then(() => { secondYielded = true })
  await h.tick()
  const sends = h.frames.filter((frame) => frame.method === 'session/send')
  assert.equal(sends[1].params.sessionId, 's2')
  h.event('s1', 'turn.completed', { response: 'stale old response', resultType: 'success' })
  await setImmediate()
  assert.equal(secondYielded, false, 'old session terminal events must be ignored')
  h.event('s2', 'turn.completed', { response: 'fresh response', resultType: 'success' })
  const chunks = [(await second.pending).value]
  for await (const chunk of second.stream) chunks.push(chunk)
  assert.equal(chunks.find((chunk) => chunk.type === 'block-end').block.text, 'fresh response')
  await first.stream.return()
})

test('stuck-turn recovery discards old queued output before replaying into a new session', async (t) => {
  const h = harness(t, true)
  const turn = h.start(undefined, 'new question')
  await h.tick()
  await h.tick()
  const sends = h.frames.filter((frame) => frame.method === 'session/send')
  assert.equal(sends[1]?.params.sessionId, 's2')
  h.event('s2', 'turn.completed', { response: 'fresh response', resultType: 'success' })
  const chunks = [(await turn.pending).value]
  for await (const chunk of turn.stream) chunks.push(chunk)
  assert.equal(chunks.find((chunk) => chunk.type === 'block-end').block.text, 'fresh response')
})
