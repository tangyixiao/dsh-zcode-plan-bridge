import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ZcodeAppServerAdapter } from '../lib/app-server.js'

async function failedTurn(message) {
  const adapter = new ZcodeAppServerAdapter({ options: () => ({
    authorizationPolicy: 'deny', appServerTimeoutMs: 5000, zcodeCliTimeoutMs: 5000,
  }) })
  const session = { sessionId: 'test-session', firstTurn: false }
  adapter.ensureSession = async () => session
  let listener
  const stopped = []
  adapter.client.onNotification = callback => { listener = callback; return () => { listener = undefined } }
  adapter.client.notify = (method, params) => stopped.push({ method, params })
  adapter.client.request = async method => {
    assert.equal(method, 'session/send')
    listener({ method: 'session/event', params: {
      sessionId: session.sessionId, type: 'turn.failed', payload: { error: { message } },
    } })
    return { accepted: true }
  }
  const chunks = []
  for await (const chunk of adapter.stream({ model: 'GLM-5.3-Flash', sessionId: 'dsh-test', messages: [] })) chunks.push(chunk)
  assert.equal(adapter.activeStreams.size, 0)
  assert.equal(listener, undefined)
  assert.equal(stopped[0]?.method, 'session/stop')
  return chunks.find(chunk => chunk.type === 'finish').reason.failure
}

for (const message of ['user concurrency limit exceeded', 'model concurrency limit exceeded']) {
  test(`${message} is retryable as RATE_LIMIT and releases the failed turn`, async () => {
    const failure = await failedTurn(message)
    assert.equal(failure.code, 'RATE_LIMIT')
    assert.match(failure.message, /concurrency limit exceeded/)
  })
}

test('an exhausted resource package remains a terminal provider error', async () => {
  const failure = await failedTurn('[1113][Insufficient balance or no resource package. Please recharge.]')
  assert.equal(failure.code, 'PROVIDER')
})
