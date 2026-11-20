import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ZSwitchAccounts } from '../lib/zswitch-accounts.js'
import { projectState } from '../lib/zswitch.js'

function harness(t) {
  const scratch = fileURLToPath(new URL('../../work/zcode-multi-account-20261116/', import.meta.url))
  fs.mkdirSync(scratch, { recursive: true }); const dir = fs.mkdtempSync(path.join(scratch, 'policy-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let active = 'one', generation = 'g-one', libraryRevision = 0, busy = false
  const calls = []
  const client = { assertRoot() {}, state: async () => projectState({ ok: true, active_account_id: active, live_hash: generation, accounts: ['one','two','three'].map(id => ({ id, name: id, updated_at: String(libraryRevision), identity: {provider:'bigmodel'} })) }),
    command: async (action, value) => { calls.push({ action, ...value }); if (action === 'switch') { active = value.id; generation = `g-${active}` }; return { switched: true } }, quota: async () => ({ remaining: 0 }) }
  const adapter = { toolkitBusy: () => busy, syncToolkitIdentity: () => { calls.push({ action:'reset-native' }) }, validateAccountModel: async model => { calls.push({ action:'model', model }) } }
  const options = () => ({ zcodeDataBaseDir: '', zSwitchAccountMode: 'shared' })
  const file = path.join(dir, 'accounts.json')
  const manager = new ZSwitchAccounts({client, adapter, options, file, generation: () => generation })
  const request = text => ({ model:'GLM-5.3-Flash', sessionId:'session', messages:[{role:'user',content:text}] })
  return {manager,client,adapter,options,file,calls,request,busy: value => busy=value, external: id => { active=id; generation=`external-${id}`; libraryRevision++ }, changedLibrary: () => libraryRevision++, generation: () => generation}
}
async function enable(h, order=['one','two','three']) { const s=await h.manager.state(); await h.manager.action({ operation:'policy', revision:s.revision, enabled:true, order }) }

test('automatic continuation is bound to the exact pending independent rotation', async t => {
  const h = harness(t)
  h.client.snapshot = async id => ({ id })
  const manager = new ZSwitchAccounts({
    client: h.client, adapter: h.adapter, file: h.file, options: () => ({}),
    profiles: { activate: snapshot => ({ managedAccount: { id: snapshot.id } }) },
  })
  assert.equal(manager.continuationEnabled(), false)
  await manager.action({ operation: 'select', id: 'one', revision: (await manager.state()).revision })
  await enable({ manager })
  assert.equal(manager.continuationEnabled(), true)
  const request = h.request('original task')
  const quota = { providerErrorCode: 1005, providerId: 'account:zai-start-plan', providerMessage: 'exceed quota limit' }
  const revision = await manager.failed(await manager.prepare(request), quota)
  assert.equal(typeof revision, 'string')
  await assert.rejects(manager.prepare(request), /account-request-replay-blocked/)
  assert.equal((await manager.prepare(request, revision)).id, 'two')
  await assert.rejects(manager.prepare(request, revision), /stale-state/)

  const secondRevision = await manager.failed(await manager.prepare(h.request('another task')), quota)
  h.changedLibrary()
  await assert.rejects(manager.prepare(request, secondRevision), /stale-state/)
  assert.equal((await manager.state()).activeId, 'two')
  assert.equal((await manager.state()).pending.from, 'two')
})

test('quota decision persists and only a new independent request consumes the pending switch', async t => {
  const h=harness(t); await enable(h)
  assert.equal(h.manager.continuationEnabled(),false)
  const snapshot=await h.manager.prepare(h.request('first'))
  await h.manager.failed(snapshot, { providerErrorCode:'1113', providerId:'account:zai-start-plan' })
  assert.equal(h.calls.filter(c=>c.action==='switch').length,0)
  await h.manager.state(); assert.equal(h.calls.filter(c=>c.action==='switch').length,0)
  await assert.rejects(h.manager.prepare(h.request('first')), /account-request-replay-blocked/)
  const restored=new ZSwitchAccounts({client:h.client,adapter:h.adapter,options:h.options,file:h.file,generation:h.generation})
  await restored.prepare(h.request('next'))
  assert.equal(h.calls.find(c=>c.action==='switch').id,'two')
  const state=await restored.state()
  assert.equal(state.primaryId,'one'); assert.equal(state.activeId,'two'); assert.deepEqual(state.exhausted,['one'])
  assert.equal(state.history.length,1)
  assert.doesNotMatch(fs.readFileSync(h.file,'utf8'), /"first"|"next"|token|credentials/)
})
for (const code of ['1005', 1005]) {
  test(`Start Plan quota ${typeof code} 1005 persists exhaustion and rotates only the next new request`, async t => {
    const h=harness(t); await enable(h)
    const request=h.request('failed quota turn')
    await h.manager.failed(await h.manager.prepare(request), { providerErrorCode:code, providerId:'account:zai-start-plan', providerMessage:'exceed quota limit' })
    const state=await h.manager.state()
    assert.deepEqual(state.exhausted,['one']); assert.equal(state.pending.from,'one')
    assert.equal(h.calls.some(c=>c.action==='switch'),false)
    await assert.rejects(h.manager.prepare(request), /account-request-replay-blocked/)
    const restored=new ZSwitchAccounts({client:h.client,adapter:h.adapter,options:h.options,file:h.file,generation:h.generation})
    await restored.prepare(h.request('continue after quota failure'))
    assert.equal((await restored.state()).activeId,'two')
    assert.equal((await restored.state()).history.length,1)
    assert.equal(h.calls.filter(c=>c.action==='switch').length,1)
    assert.doesNotMatch(fs.readFileSync(h.file,'utf8'), /exceed quota limit|failed quota turn/)
  })
}

test('1005 needs the observed Start Plan quota message and attribution; other failures never rotate', async t => {
  const h=harness(t); await enable(h)
  const quota={providerErrorCode:'1005',providerId:'account:zai-start-plan',providerMessage:'exceed quota limit'}
  for (const evidence of [
    {...quota,providerErrorCode:undefined}, {...quota,providerId:undefined}, {...quota,providerId:'custom-api'},
    {...quota,providerId:'account:bigmodel-individual-coding-plan'}, {...quota,providerId:'account:zai-individual-coding-plan'},
    {...quota,providerMessage:undefined}, {...quota,providerMessage:'user concurrency limit exceeded'},
    {...quota,providerMessage:'upstream timeout'}, {...quota,providerErrorCode:'429'},
    {...quota,cancelled:true}, {...quota,contextExceeded:true},
  ]) {
    await h.manager.failed(await h.manager.prepare(h.request('input')),evidence)
    const state=await h.manager.state()
    assert.equal(state.pending,null); assert.deepEqual(state.exhausted,[])
  }
  assert.equal(h.calls.some(c=>c.action==='switch'),false)
})

test('structured quota attribution is required; arbitrary messages and HTTP errors do not rotate', async t => {
  const h=harness(t); await enable(h)
  for(const evidence of [{message:'[1113] quota insufficient balance'}, {code:1113}, {providerErrorCode:429}, {providerErrorCode:'1302'}, {providerErrorCode:'401'}, {providerErrorCode:'1113',cancelled:true}, {providerErrorCode:'1113'}, {providerErrorCode:'1113',providerId:'custom-api'}, {providerErrorCode:'1113',providerId:'account:zai-start-plan',contextExceeded:true}]) {
    await h.manager.failed(await h.manager.prepare(h.request('input')),evidence)
    assert.equal((await h.manager.state()).pending,null)
  }
})
test('busy admission and stale owner mutations cannot switch or arm wrong-account decisions', async t => {
  const h=harness(t); await enable(h); const stale=await h.manager.state()
  const snap=await h.manager.prepare(h.request('one')); await h.manager.failed(snap,{providerErrorCode:1113,providerId:'account:zai-start-plan'})
  h.busy(true)
  await assert.rejects(h.manager.prepare(h.request('two')),/runtime-busy/)
  await assert.rejects(h.manager.action({operation:'select',id:'two',revision:(await h.manager.state()).revision}),/runtime-busy/)
  h.busy(false)
  await assert.rejects(h.manager.action({operation:'select',id:'two',revision:stale.revision}),/stale-state/)
  h.external('three'); await h.manager.failed(snap,{providerErrorCode:1113,providerId:'account:zai-start-plan'})
  await h.manager.prepare(h.request('external'))
  assert.equal(h.calls.filter(c=>c.action==='switch').length,0)
})
test('source library changes invalidate owner revision and no-candidate stops without looping', async t => {
  const h=harness(t); const stale=await h.manager.state(); h.changedLibrary()
  await assert.rejects(h.manager.action({operation:'select',id:'two',revision:stale.revision}), /stale-state/)
  await enable(h,['one'])
  await h.manager.failed(await h.manager.prepare(h.request('empty')), {providerErrorCode:'1113',providerId:'account:zai-start-plan'})
  await assert.rejects(h.manager.prepare(h.request('new')), /account-pool-exhausted/)
  await assert.rejects(h.manager.prepare(h.request('newer')), /account-pool-exhausted/)
  assert.equal(h.calls.filter(c=>c.action==='switch').length,0)
})
test('manual selection and reset are explicit recovery, and cancellation cannot send after switch', async t => {
  const h=harness(t); await enable(h)
  await h.manager.failed(await h.manager.prepare(h.request('fail')), {providerErrorCode:'1113',providerId:'account:zai-start-plan'})
  let state=await h.manager.state(); await h.manager.action({operation:'select',id:'three',revision:state.revision})
  assert.equal((await h.manager.state()).primaryId,'three')
  assert.equal((await h.manager.state()).pending,null)
  state=await h.manager.state(); await h.manager.action({operation:'reset',id:'one',revision:state.revision})
  assert.deepEqual((await h.manager.state()).exhausted,[])
  const abort=new AbortController(); abort.abort()
  await assert.rejects(h.manager.prepare({...h.request('cancel'),signal:abort.signal}),/ABORTED/)
})
test('an incompatible automatic target stops before generation and remains observable', async t => {
  const h=harness(t); await enable(h)
  await h.manager.failed(await h.manager.prepare(h.request('first')), {providerErrorCode:'1113',providerId:'account:zai-start-plan'})
  h.adapter.validateAccountModel=async()=>{throw new Error('account-model-unavailable')}
  await assert.rejects(h.manager.prepare(h.request('second')),/account-model-unavailable/)
  assert.equal((await h.manager.state()).activeId,'two')
  assert.equal(h.calls.filter(c=>c.action==='switch').length,1)
})

for (const evidence of [
  {providerErrorCode:'1113',providerId:'account:zai-start-plan'},
  {providerErrorCode:'1005',providerId:'account:zai-start-plan',providerMessage:'exceed quota limit'},
]) {
test(`independent quota ${evidence.providerErrorCode} rotation reuses snapshots without a global switch`, async t => {
  const h=harness(t)
  let selected
  h.client.snapshot=async id=>({id,revision:'library-generation'})
  const profiles={activate:(snapshot,base)=>{selected=snapshot.id;return{...base,zcodeDataBaseDir:`/private/${snapshot.id}`,managedAccount:{id:snapshot.id}}}}
  const manager=new ZSwitchAccounts({client:h.client,adapter:h.adapter,options:()=>({zcodeDataBaseDir:''}),file:h.file,profiles,generation:()=>selected??'desktop'})
  const initial=await manager.state();assert.equal(initial.mode,'independent')
  await manager.action({operation:'select',id:'two',revision:initial.revision})
  assert.equal((await manager.state()).desktopId,'one')
  assert.equal((await manager.state()).activeId,'two')
  assert.equal(manager.effectiveOptions({}).managedAccount.id,'two')
  assert.equal(h.calls.some(c=>c.action==='switch'),false)
  const state=await manager.state();await manager.action({operation:'policy',enabled:true,order:['two','three'],mode:'independent',revision:state.revision})
  h.external('three')
  const snapshot=await manager.prepare(h.request('one'))
  assert.equal((await manager.state()).activeId,'two')
  await manager.failed(snapshot, evidence)
  await manager.prepare(h.request('two'))
  assert.equal((await manager.state()).activeId,'three')
  assert.equal(h.calls.some(c=>c.action==='switch'),false)
})
}

test('an unknown current account cannot corrupt the persisted rotation document', async t => {
  const h=harness(t);const source=await h.client.state();h.client.state=async()=>({...source,activeId:null})
  const state=await h.manager.state()
  await assert.rejects(h.manager.action({operation:'policy',enabled:true,order:['one'],mode:'shared',revision:state.revision}),/account-current-unknown/)
  await h.manager.failed({id:null},{providerErrorCode:'1113'})
  assert.equal((await h.manager.state()).enabled,false)
})

test('restart hydration restores private account before catalog or plan reads', async t => {
  const h=harness(t);let chosen
  h.client.snapshot=async id=>({id})
  const profiles={activate:(snapshot,base)=>{chosen=snapshot.id;return{...base,zcodeDataBaseDir:`/private/${chosen}`,managedAccount:{id:chosen}}}}
  const options=()=>({zcodeDataBaseDir:''})
  const first=new ZSwitchAccounts({client:h.client,adapter:h.adapter,options,file:h.file,profiles})
  const state=await first.state();await first.action({operation:'select',id:'two',revision:state.revision})
  const restored=new ZSwitchAccounts({client:h.client,adapter:h.adapter,options,file:h.file,profiles})
  await restored.hydrate()
  assert.equal(restored.effectiveOptions(options()).zcodeDataBaseDir,'/private/two')
  assert.equal(h.calls.some(c=>c.action==='switch'),false)
})

test('mode transition validates the target scope before enabling rotation',async t=>{
  const h=harness(t)
  h.client.snapshot=async id=>({id})
  const manager=new ZSwitchAccounts({client:h.client,adapter:h.adapter,file:h.file,options:()=>({}),profiles:{activate:s=>({managedAccount:{id:s.id}})}})
  let state=await manager.state();await manager.action({operation:'select',id:'one',revision:state.revision})
  const source=await h.client.state();h.client.state=async()=>({...source,activeId:null})
  state=await manager.state()
  await assert.rejects(manager.action({operation:'policy',mode:'shared',enabled:true,order:['one'],revision:state.revision}),/account-current-unknown/)
  assert.equal((await manager.state()).mode,'independent')
})

test('native finalization failure always releases the account management reservation',async t=>{
  const h=harness(t);const state=await h.manager.state()
  h.adapter.syncToolkitIdentity=()=>{throw new Error('sync-failed')}
  await assert.rejects(h.manager.action({operation:'policy',mode:'shared',enabled:false,order:[],revision:state.revision}),/sync-failed/)
  assert.equal(h.manager.managing,false)
})
