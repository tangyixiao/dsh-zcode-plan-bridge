import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRetryFetch } from '../community/runtime/retry-fetch.mjs'
import { resolveConfig } from '../community/runtime/config.mjs'

const url = 'https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages'
const init = { method: 'POST', body: JSON.stringify({ model: 'test', messages: [] }) }
const policy = { baseDelayMs: 0, maxDelayMs: 0, jitter: false }
const failure = (message = 'user concurrency limit exceeded', code = '1302') =>
  new Response(JSON.stringify({ error: { message, code } }), { status: 429, headers: { 'content-type': 'application/json' } })
const sse = text => new Response(text, { headers: { 'content-type': 'text/event-stream' } })
const textEvent = 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你好"}}\n\n'

test('defaults specify six extra retries, finite budget and bounded buffers', () => {
  const c = resolveConfig({})
  assert.equal(c.maxRetries, 6); assert.equal(c.budgetMs, 600000)
  assert.equal(c.maxBodyBytes, 16 * 1024 * 1024); assert.equal(c.maxProbeBytes, 256 * 1024)
  assert.throws(() => resolveConfig({ maxRetries: -1 }))
  assert.throws(() => resolveConfig({ mystery: true }))
})

test('two transient failures then success use three identical requests', async () => {
  const bodies = [], states = []
  const fetch = createRetryFetch(async (_url, options) => {
    bodies.push(options.body)
    return bodies.length < 3 ? failure() : new Response('OK')
  }, policy, { onStatus: s => states.push(s) })
  assert.equal(await (await fetch(url, init)).text(), 'OK')
  assert.deepEqual(bodies, [init.body, init.body, init.body])
  assert.equal(states.filter(s => s.state === 'waiting').length, 2)
})

test('exhaustion permits exactly seven physical calls', async () => {
  let calls = 0
  const fetch = createRetryFetch(async () => { calls++; return failure() }, policy)
  assert.match(await (await fetch(url, init)).text(), /concurrency/)
  assert.equal(calls, 7)
})

for (const [code, message] of [['1113', 'Insufficient balance'], ['1308', 'usage limit'], ['1311', 'model forbidden'], ['401', 'Unauthorized'], ['403', 'Forbidden']]) {
  test(`terminal ${code} overrides HTTP 429`, async () => {
    let calls = 0
    const fetch = createRetryFetch(async () => { calls++; return failure(message, code) }, policy)
    await (await fetch(url, init)).text(); assert.equal(calls, 1)
  })
}

test('explicit no-retry wins and Retry-After accepts date, seconds and milliseconds', async () => {
  for (const [headers, expected] of [
    [{ 'retry-after-ms': '23' }, 23], [{ 'retry-after': '2' }, 2000],
    [{ 'retry-after': new Date(5000).toUTCString() }, 4000],
    [{ 'x-should-retry': 'false', 'retry-after': '2' }, undefined],
  ]) {
    let calls = 0; const waits = []
    const fetch = createRetryFetch(async () => {
      calls++
      return calls === 1 ? new Response('', { status: 503, headers }) : new Response('OK')
    }, policy, { now: () => 1000, sleep: async ms => waits.push(ms) })
    await (await fetch(url, init)).text()
    assert.deepEqual(waits, expected === undefined ? [] : [expected])
  }
})

test('SSE errors before content retry without leaking failed frames', async () => {
  let calls = 0
  const fetch = createRetryFetch(async () => ++calls < 3
    ? sse('event: error\ndata: {"type":"error","error":{"message":"model concurrency limit exceeded"}}\n\n')
    : sse(textEvent), policy)
  assert.equal(await (await fetch(url, init)).text(), textEvent); assert.equal(calls, 3)
})

test('UTF8 CRLF multi-line SSE and subsequent error preserve exact bytes without replay', async () => {
  const bytes = new TextEncoder().encode(': ping\r\n\r\nevent: content_block_delta\r\ndata: {"type":"content_block_delta",\r\ndata: "delta":{"text":"你好"}}\r\n\r\nevent: error\r\ndata: {"error":{"code":"1302"}}\r\n\r\n')
  let calls = 0
  const fetch = createRetryFetch(async () => {
    calls++
    return new Response(new ReadableStream({ start(c) { for (const b of bytes) c.enqueue(Uint8Array.of(b)); c.close() } }), { headers: { 'content-type': 'text/event-stream' } })
  }, policy)
  assert.deepEqual(new Uint8Array(await (await fetch(url, init)).arrayBuffer()), bytes); assert.equal(calls, 1)
})

test('unknown SSE, probe overflow and committed tool/reasoning never replay', async () => {
  for (const event of ['data: {"mystery":true}\n\n', ':'.repeat(270000),
    'data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"1","name":"Bash"}}\n\n',
    'data: {"type":"content_block_delta","delta":{"thinking":"x"}}\n\n']) {
    let calls = 0
    const fetch = createRetryFetch(async () => { calls++; return sse(event + 'data: {"error":{"code":"1302"}}\n\n') }, policy)
    assert.match(await (await fetch(url, init)).text(), /1302/); assert.equal(calls, 1)
  }
})

test('cancellation during backoff does not start another attempt', async () => {
  const controller = new AbortController(); let calls = 0
  const fetch = createRetryFetch(async () => { calls++; return failure() }, { baseDelayMs: 1000 }, {
    onStatus: s => { if (s.state === 'waiting') controller.abort() },
  })
  await assert.rejects(fetch(url, { ...init, signal: controller.signal }), { name: 'AbortError' })
  assert.equal(calls, 1)
})

test('abort during SSE probe cancels the underlying reader', async () => {
  const controller = new AbortController(); let cancelled = false
  const fetch = createRetryFetch(async () => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(': ping\n\n')); setTimeout(() => controller.abort(), 10) },
    cancel() { cancelled = true },
  }), { headers: { 'content-type': 'text/event-stream' } }), policy)
  await assert.rejects(fetch(url, { ...init, signal: controller.signal }), { name: 'AbortError' })
  assert.equal(cancelled, true)
})

test('scope excludes unrelated URLs, GET, redirects and noncopyable/oversized bodies', async () => {
  for (const [requestUrl, requestInit] of [
    ['https://example.com/v1/messages', init], ['https://zcode.z.ai/auth', init], [url, { method: 'GET' }],
    [url, { ...init, body: 'x'.repeat(16 * 1024 * 1024 + 1) }],
    [url, { ...init, body: new ReadableStream(), duplex: 'half' }],
  ]) {
    let calls = 0
    const fetch = createRetryFetch(async () => { calls++; return failure() }, policy)
    await (await fetch(requestUrl, requestInit)).text(); assert.equal(calls, 1)
  }
})

test('waiting beyond remaining budget returns original failure', async () => {
  let calls = 0
  const fetch = createRetryFetch(async () => { calls++; return new Response('', { status: 503, headers: { 'retry-after': '5' } }) }, { ...policy, budgetMs: 100 })
  assert.equal((await fetch(url, init)).status, 503); assert.equal(calls, 1)
})

test('caller cancellation remains connected after fetch returns a streaming response', async () => {
  const controller = new AbortController(); let requestSignal
  const fetch = createRetryFetch(async (_u, i) => { requestSignal = i.signal; return sse(textEvent) }, policy)
  const response = await fetch(url, { ...init, signal: controller.signal })
  controller.abort()
  assert.equal(requestSignal.aborted, true)
  await response.body.cancel()
})

test('HTTP authentication failure overrides misleading transient error', async () => {
  let calls = 0
  const fetch = createRetryFetch(async () => { calls++; return new Response(JSON.stringify({ error: { code: '1302', message: 'concurrency' } }), { status: 401 }) }, policy)
  await (await fetch(url, init)).text(); assert.equal(calls, 1)
})

for (const payload of [
  { error: { type: 'rate_limit_error', message: '[1113] 余额不足，请充值。' } },
  { error: { type: 'authentication_error', message: '认证失败' } },
  { error: { type: 'invalid_request_error', message: '无效请求' } },
  { code: 1113, error: { code: 1302, type: 'rate_limit_error', message: 'concurrency' } },
]) test(`all terminal signals take precedence: ${JSON.stringify(payload)}`, async () => {
  let calls = 0; const body = JSON.stringify(payload)
  const fetch = createRetryFetch(async () => { calls++; return new Response(body, { status: 429 }) }, policy)
  assert.equal(await (await fetch(url, init)).text(), body); assert.equal(calls, 1)
})

test('actual StartPlan HTTP429 code 3008/msg concurrency shape retries', async () => {
  let calls = 0
  const fetch = createRetryFetch(async () => ++calls < 3 ? new Response(JSON.stringify({ code: 3008, msg: 'user concurrency limit exceeded' }), { status: 429 }) : new Response('OK'), policy)
  assert.equal(await (await fetch(url, init)).text(), 'OK'); assert.equal(calls, 3)
})

test('unrecognized valid JSON SSE values preserve bytes and prevent replay', async () => {
  for (const data of ['null', '1', '[]', '{"choices":[null]}', '{"choices":[{}]}']) {
    const body = `data: ${data}\n\ndata: {"error":{"code":"1302"}}\n\n`; let calls = 0
    const fetch = createRetryFetch(async () => { calls++; return sse(body) }, policy)
    assert.equal(await (await fetch(url, init)).text(), body); assert.equal(calls, 1)
  }
})

test('copied URLSearchParams retains implicit and explicit content types', async () => {
  for (const headers of [undefined, { 'content-type': 'custom/form' }]) {
    const body = new URLSearchParams({ model: 'fixture' }); let actual
    const fetch = createRetryFetch(async (u, i) => { actual = new Request(u, i); return new Response('OK') }, policy)
    await fetch(url, { method: 'POST', body, headers })
    assert.equal(actual.headers.get('content-type'), new Request(url, { method: 'POST', body, headers }).headers.get('content-type'))
  }
})

test('prototype property names are not valid retry configuration keys', () => {
  assert.throws(() => resolveConfig(JSON.parse('{"constructor":1}')))
  assert.throws(() => resolveConfig(JSON.parse('{"__proto__":{}}')))
})
