import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'

import { ZcodeAppServerAdapter } from '../lib/app-server.js'
import { resolveOptions } from '../lib/index.js'

function harness(t, onSend, deps = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const adapter = new ZcodeAppServerAdapter({ options: () => resolveOptions({}), ...deps })
  adapter.ensureSession = async () => ({ sessionId: 's1', firstTurn: true })
  const event = (type, payload, sessionId = 's1') => adapter.client.onData(JSON.stringify({
    method: 'session/event', params: { sessionId, type, payload },
  }) + '\n')
  const delta = (kind, text, assistantMessageId) => event('model.streaming', { kind: `${kind}_delta`, delta: text, assistantMessageId })
  const finish = (response = '') => event('turn.completed', { response, resultType: 'success' })
  adapter.client.write = (message) => {
    adapter.client.onData(JSON.stringify({ id: message.id, result: {} }) + '\n')
    if (message.method === 'session/send') onSend({ delta, finish, event })
  }
  return { adapter, delta, finish }
}

async function start(t, adapter, options = {}) {
  const stream = adapter.stream({ model: 'test', sessionId: 'dsh1', messages: [], ...options })
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

test('projects completed ZCode TodoWrite snapshots into the owning DSH session', async (t) => {
  const plans = []
  const { adapter } = harness(t, ({ event, delta, finish }) => {
    const update = (payload, sessionId) => event('tool.updated', payload, sessionId)
    const started = (toolCallId, toolName = 'TodoWrite', sessionId) => update({ kind: 'started', toolCallId, toolName }, sessionId)
    const result = (toolCallId, todos, extra) => update({
      kind: 'result', toolCallId, result: { success: true, content: JSON.stringify({ todos }), ...extra },
    })
    const nativeTodos = [{ content: ' Check sample ', status: 'in_progress', priority: 'medium' }]
    started('foreign', 'TodoWrite', 'other-session')
    result('foreign', nativeTodos)
    started('read', 'Read')
    result('read', nativeTodos)
    started('failed')
    update({ kind: 'error', toolCallId: 'failed' })
    result('failed', nativeTodos)
    started('truncated')
    result('truncated', nativeTodos, { truncated: true })
    started('invalid')
    result('invalid', [...nativeTodos, { ...nativeTodos[0], content: 'Check sample' }])
    started('first')
    result('first', nativeTodos)
    result('first', nativeTodos)
    started('clear')
    result('clear', [])
    delta('text', 'answer')
    finish('answer')
  }, { publishTodos: (id, todos) => plans.push([id, todos]) })
  const { stream, first } = await start(t, adapter)
  const chunks = await collect(stream, first)
  assert.deepEqual(plans, [['dsh1', [{ content: 'Check sample', status: 'in_progress' }]], ['dsh1', []]])
  assert.equal(chunks.find((chunk) => chunk.type === 'block-end').block.text, 'answer')
  assert.ok(!chunks.some((chunk) => chunk.type === 'tool-call-delta' || chunk.blockType === 'tool-call'))
})

test('ignores native todos from auxiliary requests', async (t) => {
  const plans = []
  const { adapter } = harness(t, ({ event, finish }) => {
    event('tool.updated', { kind: 'started', toolCallId: 'todo', toolName: 'TodoWrite' })
    event('tool.updated', { kind: 'result', toolCallId: 'todo', result: { success: true, content: '{"todos":[]}' } })
    finish('title')
  }, { publishTodos: (_id, todos) => plans.push(todos) })
  const { stream, first } = await start(t, adapter, { purpose: 'session-title' })
  await collect(stream, first)
  assert.deepEqual(plans, [])
})

test('registers a confirmed native subagent before the parent turn finishes', async (t) => {
  const children = []
  const { adapter, finish } = harness(t, ({ event, delta }) => {
    const child = {
      agentId: 'agent_child', agentType: 'Explore', childSessionId: 'sess_subagent_agent_child',
      parentToolCallId: 'call-agent', status: 'running', description: 'Inspect fixture', prompt: 'Private task prompt',
    }
    event('session.updated', child)
    event('tool.updated', { kind: 'started', toolName: 'Agent', toolCallId: 'call-agent' })
    event('session.updated', child, 'other-session')
    event('session.updated', { ...child, status: 'completed' })
    event('session.updated', child)
    event('session.updated', child)
    delta('text', 'answer')
  }, { publishSubagent: (id, child) => children.push([id, child]) })

  const { stream, first } = await start(t, adapter)
  assert.deepEqual(children.map(([id, { createdAt, ...child }]) => [id, child]), [[
    'dsh1', { id: 'sess_subagent_agent_child', name: 'agent_child', label: 'Inspect fixture' },
  ]])
  finish('answer')
  const chunks = await collect(stream, first)
  assert.equal(chunks.find((chunk) => chunk.type === 'block-end').block.text, 'answer')
})

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

test('preserves native message boundaries and joins deltas from the same message', async (t) => {
  const { adapter } = harness(t, ({ delta, finish }) => {
    delta('reasoning', '先查', 'first')
    delta('text', '检查', 'first')
    delta('text', '仓库。', 'first')
    delta('reasoning', '再测', 'second')
    delta('text', '开始测试。\n', 'second')
    delta('text', '\n测试通过。\n第二行。', 'third')
    finish()
  })
  const { stream, first } = await start(t, adapter)
  const chunks = await collect(stream, first)
  const text = '检查仓库。\n\n开始测试。\n\n测试通过。\n第二行。'
  assert.equal(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join(''), text)
  assert.equal(chunks.find((chunk) => chunk.type === 'block-end').block.text, text)
  assert.equal(chunks.filter((chunk) => chunk.type === 'reasoning-delta').map((chunk) => chunk.text).join(''), '先查\n\n再测')
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
