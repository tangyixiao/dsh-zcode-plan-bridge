import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import * as attach from '../community/runtime/native-attach.mjs'

const url = new URL('../community/runtime/owned-inspector.mjs', import.meta.url)
const module = fs.existsSync(url) ? await import(url) : null

for (const failure of ['none', 'connect', 'identity', 'install', 'close', 'occupied', 'wrong-pid']) {
  test(`owned inspector cleanup: ${failure}`, async () => {
    assert.equal(typeof module?.withOwnedInspector, 'function', 'owned inspector lifecycle is required')
    let listening = failure === 'occupied', opens = 0, connections = 0, evaluations = 0, closes = 0, unlocked = false
    const io = {
      lock: async () => () => { unlocked = true },
      list: async () => listening ? [{ webSocketDebuggerUrl: 'ws://127.0.0.1:9229/test' }] : null,
      open: () => { opens++; listening = true },
      pause: async () => {},
      connect: async () => {
        if (failure === 'connect' && ++connections === 1) throw new Error('Connection failed')
        return {
          evaluate: async expression => {
            if (failure === 'identity' && ++evaluations === 1) throw new Error('Identity response lost')
            if (expression.includes('delete globalThis[k]')) {
              if (failure === 'close') throw new Error('Close failed')
              listening = false; closes++; return true
            }
            return expression === 'process.pid' ? (failure === 'wrong-pid' ? 2 : 1) : { pid: failure === 'wrong-pid' ? 2 : 1 }
          }, close() {},
        }
      },
    }
    const promise = module.withOwnedInspector(1, async () => { if (failure === 'install') throw new Error('Install failed'); return 'installed' }, io)
    if (failure === 'none') assert.equal(await promise, 'installed')
    else await assert.rejects(promise)
    assert.equal(unlocked, true)
    if (failure === 'occupied') { assert.equal(opens, 0); assert.equal(closes, 0); assert.equal(listening, true) }
    else if (failure === 'wrong-pid') { assert.equal(closes, 0, 'an unverified inspector is never closed') }
    else if (failure !== 'close') { assert.equal(listening, false, 'the plugin-owned inspector must close on every verified failure path') }
  })
}

for (const failure of ['error', 'timeout', 'closed-after-open']) test(`inspector WebSocket releases resources after ${failure}`, { timeout: 4000 }, async () => {
  assert.equal(typeof attach.connectInspector, 'function')
  let socket
  class Socket {
    constructor() { socket = this; this.closed = false }
    close() { this.closed = true }
    send() {}
  }
  const pending = attach.connectInspector('ws://127.0.0.1:9229/abc-def', Socket)
  if (failure === 'closed-after-open') {
    socket.onopen()
    const client = await pending
    const call = client.call('Runtime.evaluate', { expression: '1' })
    const rejected = assert.rejects(call, /closed/)
    assert.equal(typeof socket.onclose, 'function')
    socket.onclose()
    await rejected
    client.close()
  } else {
    const rejected = assert.rejects(pending, /failed|timed out/)
    if (failure === 'error') socket.onerror()
    await rejected
  }
  assert.equal(socket.closed, true)
})
