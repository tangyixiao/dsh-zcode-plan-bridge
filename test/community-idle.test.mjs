import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'

const url = new URL('../community/runtime/model-idle.mjs', import.meta.url)
const idle = fs.existsSync(url) ? await import(url) : null

test('managed streams have no native idle deadline while awaiting retry, without mutating shared adapters', async () => {
  assert.equal(typeof idle?.installIdleGuard, 'function')
  class Adapter {
    constructor() { this.streamIdleTimeoutMs = 20 }
    async *streamTextWithResolved() { yield this.streamIdleTimeoutMs }
  }
  const original = Adapter.prototype.streamTextWithResolved
  const restore = idle.installIdleGuard(Adapter.prototype, resolved => resolved.managed)
  try {
    const adapter = new Adapter()
    assert.deepEqual(await Array.fromAsync(adapter.streamTextWithResolved({}, { managed: true })), [0])
    assert.equal(adapter.streamIdleTimeoutMs, 20)
    assert.deepEqual(await Array.fromAsync(adapter.streamTextWithResolved({}, { managed: false })), [20])
  } finally { restore() }
  assert.equal(Adapter.prototype.streamTextWithResolved, original)
})

test('after output, continuous SSE comments cannot prevent model-event idle timeout or replay the request', async () => {
  assert.equal(typeof idle?.markCommittedResponse, 'function')
  let physicalRequests = 0, heartbeats = 0, aborted = false
  class Adapter {
    constructor() { this.streamIdleTimeoutMs = 20 }
    async *streamTextWithResolved(request) {
      physicalRequests++
      let interval
      const body = new ReadableStream({ start(c) {
        c.enqueue('data: hello\n\n')
        interval = setInterval(() => { heartbeats++; c.enqueue(': ping\n\n') }, 3)
      }, cancel() { clearInterval(interval) } })
      const response = idle.markCommittedResponse(new Response(body, { headers: { 'content-type': 'text/event-stream' } }))
      const reader = response.body.getReader()
      const abort = () => { aborted = true; void reader.cancel() }
      request.abortSignal.addEventListener('abort', abort, { once: true })
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) return
          if (chunk.value.startsWith('data:')) yield chunk.value
        }
      } finally { request.abortSignal.removeEventListener('abort', abort); await reader.cancel() }
    }
  }
  const restore = idle.installIdleGuard(Adapter.prototype, () => true)
  try {
    const iterator = new Adapter().streamTextWithResolved({}, {})
    assert.equal((await iterator.next()).value, 'data: hello\n\n')
    await assert.rejects(iterator.next(), /no event received/i)
    await iterator.return()
    assert.ok(heartbeats > 0)
    assert.equal(physicalRequests, 1)
    assert.equal(aborted, true)
  } finally { restore() }
})

test('a pending next starts its idle clock when fetch commits later, after unlimited retry waiting', async () => {
  let committedAt = 0, aborted = false
  class Adapter {
    constructor() { this.streamIdleTimeoutMs = 20 }
    async *streamTextWithResolved(request) {
      await new Promise(resolve => setTimeout(resolve, 60))
      assert.equal(request.abortSignal.aborted, false, 'retry wait must exceed the old native idle deadline')
      idle.markCommittedResponse(new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } }))
      committedAt = Date.now()
      await new Promise(resolve => request.abortSignal.addEventListener('abort', () => { aborted = true; resolve() }, { once: true }))
    }
  }
  const restore = idle.installIdleGuard(Adapter.prototype, () => true)
  try {
    const iterator = new Adapter().streamTextWithResolved({}, {})
    await assert.rejects(iterator.next(), /no event received/i)
    assert.ok(Date.now() - committedAt >= 15)
    assert.equal(aborted, true)
    await iterator.return()
  } finally { restore() }
})
