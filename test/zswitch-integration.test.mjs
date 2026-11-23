import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ZcodeAppServerAdapter } from '../lib/app-server.js'
import { ZSwitchAccounts } from '../lib/zswitch-accounts.js'
import { ZSwitchProfiles } from '../lib/zswitch-profiles.js'
import { resolveOptions } from '../lib/index.js'
import { parseToolkitAction } from '../lib/toolkit-route.js'
import { waitForQuotaCheckpoint } from '../lib/quota-continuation.js'

test('account selection defaults to DSH independence and account actions remain closed',()=>{
  assert.equal(resolveOptions({}).zSwitchAccountMode,'independent')
  assert.equal(resolveOptions({}).resumeOnQuotaExhaustion,true)
  assert.equal(resolveOptions({resumeOnQuotaExhaustion:false}).resumeOnQuotaExhaustion,false)
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

test('the DSH stream defaults to checkpointed continuation after native drain', async () => {
  const adapter = new ZcodeAppServerAdapter({ options: () => resolveOptions({}) })
  const request = { model: 'GLM-5.3-Flash', sessionId: 'DSH',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Finish the migration' }] }] }
  const steps = []
  let current = 1
  let reads = 0
  adapter.accountController = {
    managing: false,
    continuationEnabled: () => true,
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

test('native auth callbacks never receive host credentials', () => {
  const adapter = new ZcodeAppServerAdapter({ options: () => resolveOptions({}) })
  const writes = []
  adapter.client.write = value => writes.push(value)
  adapter.client.dispatch({ id: 1, method: 'interaction/requestProviderRuntimeHeaders', params: { providerId: 'account:zai-start-plan' } })
  assert.deepEqual(writes, [{ id: 1, result: { headersApplied: false } }])
})

test('a migrated selection serves ordinary and title turns before and after a native quota switch', async t => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dsh-admission-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const base = resolveOptions({ accountMode: 'start-plan', cliCwd: dir, zcodeDataBaseDir: dir, resumeOnQuotaExhaustion: false })
  const accounts = ['old', 'next'].map(id => ({ id, name: id, provider: 'zai', identityHash: id, userId: id }))
  const client = { state: async () => ({ accounts, activeId: 'old', revision: 'fixture' }) }
  const profiles = new ZSwitchProfiles({
    root: path.join(dir, 'profiles'), cli: () => path.join(dir, 'fixture.cjs'),
    run: async (_cli, _node, provider, env) => {
      const member = accounts.find(row => env.ZCODE_DATA_BASE_DIR.startsWith(profiles.directory(row.id) + path.sep))
      fs.writeFileSync(env.ZCODE_CREDENTIALS_FILE, 'opaque fixture')
      return { status: 'ready', provider, credentialsPath: env.ZCODE_CREDENTIALS_FILE, user: { user_id: member.id } }
    },
  })
  let controller
  const adapter = new ZcodeAppServerAdapter({ options: () => controller?.effectiveOptions(base) ?? base })
  controller = new ZSwitchAccounts({ adapter, client, profiles, file: path.join(dir, 'accounts.json'), options: () => base })
  adapter.accountController = controller
  t.after(() => { adapter.dispose(); controller.dispose() })
  controller.update('initial', policy => {
    Object.assign(policy, { selectedId: 'old', primaryId: 'old', enabled: true, order: ['old', 'next'] })
  })

  let session = 0, exhaust = false
  const sends = []
  const mainAccepted = Promise.withResolvers()
  const finishMain = Promise.withResolvers()
  // The fake server is ready immediately at the two native 1.5 s startup waits.
  const realTimeout = globalThis.setTimeout
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => realTimeout(fn, ms === 1500 ? 0 : ms, ...args))
  const rpc = Object.getPrototypeOf(adapter.client)
  t.mock.method(rpc, 'ensureStarted', async () => {})
  t.mock.method(rpc, 'write', function (frame) {
    const account = this.options().managedAccount.id
    const result = frame.method === 'session/create' ? {
      session: { sessionId: account + '-' + (++session) },
      settings: { model: { available: [{ ref: { providerId: 'account:zai-start-plan', modelId: 'same' } }] } },
    } : {}
    this.dispatch({ id: frame.id, result })
    if (frame.method === 'session/send') {
      const { sessionId } = frame.params
      sends.push({ account, sessionId })
      const payload = exhaust ? { error: { message: 'insufficient balance', attribution: {
        providerErrorCode: '1113', providerId: 'account:zai-start-plan', modelId: 'same',
      } } } : { response: 'ok', resultType: 'success' }
      const event = { method: 'session/event', params: { sessionId, type: exhaust ? 'turn.failed' : 'turn.completed', payload } }
      if (sends.length === 2) {
        mainAccepted.resolve()
        void finishMain.promise.then(() => this.dispatch(event))
      } else this.dispatch(event)
    }
  })
  const messages = []
  const turn = (text, purpose) => {
    const user = { role: 'user', content: [{ type: 'text', text }] }
    if (!purpose) messages.push(user)
    return Array.fromAsync(adapter.stream({ sessionId: 'conversation', model: 'same', messages: purpose ? [user] : [...messages], purpose }))
  }
  await assert.rejects(turn('before login'), /account-login-required/)
  await assert.rejects(turn('before login', 'session-title'), /account-login-required/)
  assert.deepEqual(sends, [])
  for (const member of accounts) await profiles.login(base, member, 'zai')
  assert.equal((await turn('first')).at(-1).reason.kind, 'stop')
  const main = turn('cached')
  try {
    await Promise.race([mainAccepted.promise, main])
    assert.equal((await turn('concurrent title', 'session-title')).at(-1).reason.kind, 'stop')
  } finally { finishMain.resolve() }
  assert.equal((await main).at(-1).reason.kind, 'stop')
  assert.equal(sends[0].sessionId, sends[1].sessionId)
  assert.notEqual(sends[1].sessionId, sends[2].sessionId)
  exhaust = true
  assert.equal((await turn('exhaust')).at(-1).reason.kind, 'error')
  assert.equal(controller.document().pending.from, 'old')
  exhaust = false
  await turn('pending title', 'session-title')
  assert.equal(controller.document().pending.from, 'old')
  assert.equal((await turn('after switch')).at(-1).reason.kind, 'stop')
  await turn('new title', 'session-title')
  assert.deepEqual(sends.map(send => send.account), ['old', 'old', 'old', 'old', 'old', 'next', 'next'])
  assert.equal(controller.document().selectedId, 'next')
  assert.equal(adapter.toolkitBusy(), false)
})
