import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'

import { ZcodeAppServerAdapter } from '../lib/app-server.js'
import { resolveOptions } from '../lib/index.js'

function harness(t, onSend) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const adapter = new ZcodeAppServerAdapter({ options: () => resolveOptions({}) })
  adapter.ensureSession = async () => ({ sessionId: 's1', firstTurn: true })
  const event = (type, payload) => adapter.client.onData(JSON.stringify({
    method: 'session/event', params: { sessionId: 's1', type, payload },
  }) + '\n')
  const delta = (kind, text) => event('model.streaming', { kind: `${kind}_delta`, delta: text })
  const finish = (response = '') => event('turn.completed', { response, resultType: 'success' })
  adapter.client.write = (message) => {
    adapter.client.onData(JSON.stringify({ id: message.id, result: {} }) + '\n')
    if (message.method === 'session/send') onSend({ delta, finish })
  }
  return { adapter, delta, finish }
}

async function start(t, adapter) {
  const stream = adapter.stream({ model: 'test', sessionId: 'dsh1', messages: [] })
  const first = stream.next()
  await setImmediate()
  t.mock.timers.tick(1500)
  await setImmediate()
  return { stream, first: await first }
}

async function collect(stream, first) {
  const chunks = first.done ? [] : [first.value]
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

test('completion drain filters reasoning tags split across deltas', async (t) => {
  const { adapter } = harness(t, ({ delta, finish }) => {
    delta('reasoning', 'thinking <antml:in')
    delta('reasoning', 'voke name="bash">secret')
    delta('text', 'answer')
    finish('answer')
  })
  const { stream, first } = await start(t, adapter)
  const chunks = await collect(stream, first)
  assert.equal(chunks.filter((chunk) => chunk.type === 'reasoning-delta').map((chunk) => chunk.text).join(''), 'thinking ')
  assert.equal(chunks.find((chunk) => chunk.type === 'block-end').block.text, 'answer')
})

test('completion drain filters a complete reasoning pseudo-tool block', async (t) => {
  const { adapter } = harness(t, ({ delta, finish }) => {
    delta('reasoning', 'thinking <invoke>secret</invoke>')
    finish()
  })
  const { stream, first } = await start(t, adapter)
  const chunks = await collect(stream, first)
  assert.equal(chunks.filter((chunk) => chunk.type === 'reasoning-delta').map((chunk) => chunk.text).join(''), 'thinking ')
})

test('text deltas and final block agree after a split pseudo-tag is intercepted', async (t) => {
  const { adapter } = harness(t, ({ delta, finish }) => {
    for (const text of ['正文', '<antml', ':inv', 'oke>secret']) delta('text', text)
    finish('正文<antml:invoke>secret')
  })
  const { stream, first } = await start(t, adapter)
  const chunks = await collect(stream, first)
  const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
  assert.ok(text.startsWith('正文'))
  assert.doesNotMatch(text, /<antml|secret/)
  assert.equal(chunks.find((chunk) => chunk.type === 'block-end').block.text, text)
})

test('live reasoning filtering persists through completion drain without affecting text', async (t) => {
  const { adapter, delta, finish } = harness(t, ({ delta }) => {
    delta('reasoning', 'thinking <antml:in')
  })
  const { stream, first } = await start(t, adapter)
  assert.equal(first.value.type, 'reasoning-delta')
  assert.equal(first.value.text, 'thinking ')
  delta('reasoning', 'voke>secret')
  delta('text', 'function_calls is an ordinary word; 1 < 2')
  finish('function_calls is an ordinary word; 1 < 2')
  const chunks = await collect(stream, first)
  assert.equal(chunks.filter((chunk) => chunk.type === 'reasoning-delta').map((chunk) => chunk.text).join(''), 'thinking ')
  const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
  assert.equal(text, 'function_calls is an ordinary word; 1 < 2')
})

test('a partial reasoning tag is discarded at clean EOF', async (t) => {
  const { adapter } = harness(t, ({ delta, finish }) => {
    delta('reasoning', 'thinking <antml:in')
    finish()
  })
  const { stream, first } = await start(t, adapter)
  const chunks = await collect(stream, first)
  assert.equal(chunks.filter((chunk) => chunk.type === 'reasoning-delta').map((chunk) => chunk.text).join(''), 'thinking ')
})

test('final-response-only text passes through the same filter', async (t) => {
  const { adapter } = harness(t, ({ finish }) => finish('safe <invoke>secret'))
  const { stream, first } = await start(t, adapter)
  const chunks = await collect(stream, first)
  const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
  assert.ok(text.startsWith('safe '))
  assert.doesNotMatch(text, /<invoke|secret/)
  assert.equal(chunks.find((chunk) => chunk.type === 'block-end').block.text, text)
})

test('clean completion flushes an ordinary pending less-than character', async (t) => {
  const { adapter } = harness(t, ({ delta, finish }) => {
    delta('text', 'answer <')
    delta('reasoning', 'thinking </')
    finish('answer <')
  })
  const { stream, first } = await start(t, adapter)
  const chunks = await collect(stream, first)
  assert.equal(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join(''), 'answer <')
  assert.equal(chunks.filter((chunk) => chunk.type === 'reasoning-delta').map((chunk) => chunk.text).join(''), 'thinking </')
  assert.equal(chunks.find((chunk) => chunk.type === 'block-end').block.text, 'answer <')
})
