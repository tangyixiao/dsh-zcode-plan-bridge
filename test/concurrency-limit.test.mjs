import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ZcodeAppServerAdapter } from '../lib/app-server.js'

async function failedTurn(message, fields = {}) {
  const adapter = new ZcodeAppServerAdapter({ options: () => ({
    authorizationPolicy: 'deny', appServerTimeoutMs: 5000, zcodeCliTimeoutMs: 5000,
  }) })
  const session = { sessionId: 'test-session', firstTurn: false }
  adapter.sessions.set('dsh-test',session)
  adapter.ensureSession = async () => session
  let listener
  const stopped = []
  const closed = []
  adapter.client.onNotification = callback => { listener = callback; return () => { listener = undefined } }
  adapter.client.notify = () => { throw new Error('session/stop must be an acknowledged request') }
  adapter.client.request = async (method, params) => {
    if (method === 'session/stop') { stopped.push({ method, params }); return {} }
    if (method === 'session/close') { closed.push(params); return {} }
    assert.equal(method, 'session/send')
    listener({ method: 'session/event', params: {
      sessionId: session.sessionId, type: 'turn.failed', payload: { error: { message,...fields } },
    } })
    return { accepted: true }
  }
  const chunks = []
  for await (const chunk of adapter.stream({ model: 'GLM-5.3-Flash', sessionId: 'dsh-test', messages: [] })) chunks.push(chunk)
  assert.equal(adapter.activeStreams.size, 0)
  assert.equal(listener, undefined)
  assert.equal(stopped[0]?.method, 'session/stop')
  if (message === 'Model request exceeded the provider context window.' || fields.code === 'CONTEXT_WINDOW_EXCEEDED') { assert.equal(adapter.sessions.has('dsh-test'),false); assert.equal(closed[0]?.sessionId,session.sessionId) }
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

for(const [message,fields] of [
  ['Model request exceeded the provider context window.',{}],
  ['Native capacity error',{code:'CONTEXT_WINDOW_EXCEEDED'}],
  ['maximum context length exceeded',{}],
])test('context overflow reaches the canonical DSH recovery code: '+message,async()=>{
  const failure=await failedTurn(message,fields)
  assert.equal(failure.code,'CONTEXT_WINDOW_EXCEEDED')
})

test('validation limits do not become context overflow',async()=>{
  const failure=await failedTurn('invalid input: temperature exceeds maximum allowed value')
  assert.notEqual(failure.code,'CONTEXT_WINDOW_EXCEEDED')
})

test('a thrown native RPC context overflow retains its canonical code and evicts the failed session',async()=>{
  const adapter=new ZcodeAppServerAdapter({options:()=>({authorizationPolicy:'deny',appServerTimeoutMs:5000,zcodeCliTimeoutMs:5000})})
  const session={sessionId:'native',firstTurn:false};adapter.sessions.set('s',session);adapter.ensureSession=async()=>session
  adapter.client.onNotification=()=>()=>{}
  adapter.client.request=async method=>{if(method==='session/stop'||method==='session/close')return{};throw new Error('Model request exceeded the provider context window.')}
  await assert.rejects(async()=>{for await(const _chunk of adapter.stream({sessionId:'s',model:'GLM-5.3-Flash',messages:[]})){}},{code:'CONTEXT_WINDOW_EXCEEDED'})
  assert.equal(adapter.sessions.has('s'),false)
})
