import assert from 'node:assert/strict'
import test from 'node:test'
import { ZcodeAppServerAdapter } from '../lib/app-server.js'
import { resolveOptions } from '../lib/index.js'
import { parseToolkitAction } from '../lib/toolkit-route.js'
import { waitForQuotaCheckpoint } from '../lib/quota-continuation.js'

test('account selection defaults to DSH independence and account actions remain closed',()=>{
  assert.equal(resolveOptions({}).zSwitchAccountMode,'independent')
  const value={action:'accounts',scope:'a'.repeat(64),revision:'initial',account:{operation:'select',id:'one',revision:'b'.repeat(64)}}
  assert.deepEqual(parseToolkitAction(value),value)
  assert.equal(parseToolkitAction({...value,account:{...value.account,credentials:'SECRET'}}),undefined)
  assert.equal(parseToolkitAction({...value,account:{...value.account,id:'../one'}}),undefined)
})
test('stream admission captures account, reports structured quota and never resends',async()=>{
  const adapter=new ZcodeAppServerAdapter({options:()=>resolveOptions({})})
  const calls=[]
  adapter.accountController={managing:false,enabled:()=>true,prepare:async()=>{calls.push('prepare');return{id:'one'}},failed:async(snapshot,evidence)=>{calls.push({snapshot,evidence})}}
  let sends=0
  adapter.streamTurn=async function*(_options,_usage,_settled,onFailure){sends++;onFailure?.({providerErrorCode:'1113'});yield{type:'finish',reason:{kind:'error',failure:{code:'PROVIDER',message:'quota'}}}}
  const chunks=[];for await(const chunk of adapter.stream({model:'GLM-5.3-Flash',messages:[]}))chunks.push(chunk)
  assert.equal(calls[0],'prepare');assert.equal(calls[1].snapshot.id,'one');assert.equal(calls[1].evidence.providerErrorCode,'1113')
  assert.equal(sends,1);assert.equal(adapter.toolkitRequests,0)
  assert.equal(adapter.providerRetryPolicy().maxRetries,0)
})

function nativeSnapshot(id, eventSeq, status, jobStatus) {
  return {
    projection: { sessionId: id, status, activeToolCalls: [], pendingPermissions: [],
      backgroundJobs: [{ toolName: 'Bash', description: 'build fixtures', status: jobStatus }] },
    runtime: { eventSeq },
    messages: [{ info: { role: 'assistant' }, parts: [
      { type: 'tool', tool: 'Edit', state: { status: 'completed', title: 'Update parser.js', output: 'not needed in checkpoint' } },
    ] }],
    todos: [{ content: 'Run regression checks', status: 'pending' }],
  }
}

test('native drain checkpoint observes background work, follow-up turn, and stable idle', async () => {
  const id = 'native'
  const snapshots = [
    nativeSnapshot(id, 1, 'error', 'running'),
    nativeSnapshot(id, 2, 'busy', 'completed'),
    nativeSnapshot(id, 3, 'error', 'completed'),
    nativeSnapshot(id, 4, 'error', 'completed'),
    nativeSnapshot(id, 4, 'error', 'completed'),
  ]
  let reads = 0
  const input = { sessionId: id, ids: [id], stillCurrent: () => true, read: async () => snapshots[reads++] }
  const progress = await waitForQuotaCheckpoint(input, { timeoutMs: 2000, intervalMs: 1 })
  assert.equal(reads, 5)
  assert.match(progress, /Update parser\.js/)
  assert.match(progress, /Run regression checks/)
  assert.doesNotMatch(progress, /not needed in checkpoint/)

  const controller = new AbortController()
  const abortAfterRead = async () => {
    controller.abort()
    return nativeSnapshot(id, 1, 'error', 'running')
  }
  assert.equal(await waitForQuotaCheckpoint({ ...input, signal: controller.signal, read: abortAfterRead }), undefined)
  assert.equal(await waitForQuotaCheckpoint({ ...input, read: async () => ({}) }), undefined)
})

test('the DSH stream switches only after native drain and sends a checkpointed continuation', async () => {
  const adapter = new ZcodeAppServerAdapter({ options: () => resolveOptions({ resumeOnQuotaExhaustion: true }) })
  const request = { model: 'GLM-5.3-Flash', sessionId: 'DSH',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Finish the migration' }] }] }
  const steps = []
  let current = 1
  let reads = 0
  adapter.accountController = {
    managing: false,
    prepare: async (options, revision) => {
      assert.equal(options, request)
      if (revision !== undefined) {
        assert.equal(revision, 'quota-revision')
        assert.ok(reads >= 3)
        assert.equal(steps.at(-1), 'stop old')
        assert.equal(adapter.toolkitBusy(), false)
        steps.push('switch account')
        current += 1
      }
      return { id: current }
    },
    failed: async (account, failure) => {
      assert.equal(account.id, 1)
      assert.equal(failure.providerErrorCode, 1005)
      assert.equal(failure.sessionId, 'native-1')
      return 'quota-revision'
    },
  }
  adapter.ensureSession = async () => ({ sessionId: `native-${current}`, firstTurn: true })
  let emit
  adapter.client.onNotification = callback => { emit = callback; return () => {} }
  adapter.client.request = async (method, params) => {
    if (method === 'session/read') {
      assert.equal(current, 1)
      assert.equal(params.contentProfile, 'index')
      reads += 1
      return nativeSnapshot(params.sessionId, reads === 1 ? 1 : 2, 'error', reads === 1 ? 'running' : 'completed')
    }
    if (method === 'session/stop') steps.push('stop old')
    if (method === 'session/send') {
      steps.push(params.content)
      const event = (type, payload) => emit({ method: 'session/event', params: { sessionId: params.sessionId, type, payload } })
      if (current === 1) {
        event('model.streaming', { kind: 'text_delta', delta: 'First account progress' })
        event('turn.failed', { error: { message: 'exceed quota limit', attribution: { providerErrorCode: 1005, providerId: 'account:zai-start-plan' } } })
      } else {
        event('turn.completed', { response: 'Finished', usage: { inputTokens: 9, outputTokens: 2 } })
      }
    }
    return {}
  }
  const chunks = await Array.fromAsync(adapter.stream(request))
  assert.match(steps[0], /Finish the migration/)
  assert.doesNotMatch(steps[0], /DSH 自动续跑/)
  assert.match(steps[3], /DSH 自动续跑/)
  assert.match(steps[3], /Update parser\.js/)
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'block-end').map(chunk => [chunk.index, chunk.block.text]),
    [[1, 'First account progress'], [3, 'Finished']])
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'finish').map(chunk => chunk.reason.kind), ['stop'])
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'usage').map(chunk => chunk.usage), [{ inputTokens: 9, outputTokens: 2 }])
  assert.equal(adapter.toolkitBusy(), false)
})
for (const [providerErrorCode, message] of [['1113','insufficient balance'],['1005','exceed quota limit']]) {
test(`native quota ${providerErrorCode} attribution and message survive until policy`,async()=>{
  const adapter=new ZcodeAppServerAdapter({options:()=>resolveOptions({})})
  adapter.ensureSession=async()=>({sessionId:'native',firstTurn:false})
  let listener,observed
  adapter.client.onNotification=callback=>{listener=callback;return()=>{}}
  adapter.client.request=async method=>{if(method==='session/send')listener({method:'session/event',params:{sessionId:'native',type:'turn.failed',payload:{error:{message,attribution:{providerErrorCode,providerId:'account:zai-start-plan'}}}}});return{}}
  for await(const _chunk of adapter.streamTurn({model:'GLM-5.3-Flash',messages:[]},undefined,undefined,value=>{observed=value})){}
  assert.equal(observed.providerErrorCode,providerErrorCode)
  assert.equal(observed.providerId,'account:zai-start-plan')
  assert.equal(observed.providerMessage,message)
})
}

test('shared login changes stop the owned old agent before any auth fallback',async()=>{
  const adapter=new ZcodeAppServerAdapter({options:()=>resolveOptions({zcodeDataBaseDir:'nonexistent-zswitch-source-fixture'})})
  let disposed=false,notified=false
  adapter.client.accountGeneration='old-generation'
  adapter.client.dispose=()=>{disposed=true}
  adapter.client.onExit=()=>{notified=true}
  const writes=[];adapter.client.write=value=>writes.push(value)
  await adapter.client.handleRuntimeHeadersRequest({id:1})
  assert.equal(disposed,true);assert.equal(notified,true)
  assert.equal(writes[0].result.headersApplied,false)
  assert.equal(writes[0].result.requestAuth,undefined)
})
