import assert from 'node:assert/strict'
import test from 'node:test'
import { ZcodeAppServerAdapter } from '../lib/app-server.js'
import { resolveOptions } from '../lib/index.js'
import { parseToolkitAction } from '../lib/toolkit-route.js'

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
test('native turn attribution survives until policy while displayed errors remain compatible',async()=>{
  const adapter=new ZcodeAppServerAdapter({options:()=>resolveOptions({})})
  adapter.ensureSession=async()=>({sessionId:'native',firstTurn:false})
  let listener,observed
  adapter.client.onNotification=callback=>{listener=callback;return()=>{}}
  adapter.client.request=async method=>{if(method==='session/send')listener({method:'session/event',params:{sessionId:'native',type:'turn.failed',payload:{error:{message:'insufficient balance',attribution:{providerErrorCode:'1113',providerId:'account:zai-start-plan'}}}}});return{}}
  for await(const _chunk of adapter.streamTurn({model:'GLM-5.3-Flash',messages:[]},undefined,undefined,value=>{observed=value})){}
  assert.equal(observed.providerErrorCode,'1113')
  assert.equal(observed.providerId,'account:zai-start-plan')
})

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
