import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { ZSwitchProfiles, isolatedCli, profileEnvironment } from '../lib/zswitch-profiles.js'
import { ZSwitchClient } from '../lib/zswitch.js'

function harness(t) {
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dsh-profile-'))
  t.after(() => fs.rmSync(scratch, {recursive:true,force:true}))
  const root = path.join(scratch,'official-profiles')
  const cli = path.join(scratch,'fixture.cjs')
  fs.writeFileSync(cli, `
    const fs = require('node:fs')
    const [cmd, provider, format] = process.argv.slice(2)
    if (cmd !== 'login' || format !== '--json' || process.cwd() !== process.env.ZCODE_DATA_BASE_DIR
      || process.env.USERPROFILE !== process.cwd() || process.env.HOME !== process.cwd()
      || process.env.DSH_TEST_SECRET || process.env.ZCODE_CLI_SETTINGS_FILE) process.exit(1)
    fs.writeFileSync(process.env.ZCODE_CREDENTIALS_FILE,'opaque fixture')
    console.log(JSON.stringify({status:'ready',provider, user:{user_id:'first'}, credentialsPath:process.env.ZCODE_CREDENTIALS_FILE}))
  `)
  const profiles = new ZSwitchProfiles({root,cli:()=>cli})
  return {scratch,root,cli,profiles}
}
const member = {id:'one',provider:'zai',userId:'first',identityHash:'fixture-user-hash'}

test('official browser entry runs under a private home and verifies identity before authorizing a profile', async t => {
  const {scratch,profiles} = harness(t)
  const client = new ZSwitchClient({path:path.join(scratch,'manager'),run:async()=>({stdout:JSON.stringify({
    ok:true,accounts:[{id:'one',name:'First',identity:{provider:'zai',user_id:'first'}}],
  })})})
  const account = await client.member('one')
  const legacy = path.join(scratch,'native-profiles','one')
  fs.mkdirSync(legacy,{recursive:true}); fs.writeFileSync(path.join(legacy,'source.json'),'old cache')
  assert.throws(()=>profiles.activate(account,{}),/account-login-required/)
  const previous = process.env.DSH_TEST_SECRET
  process.env.DSH_TEST_SECRET = 'not inherited'
  try {
    assert.deepEqual(await profiles.login({zcodeCliNode:process.execPath},account,'zai'),{id:'one',provider:'zai',binding:'existing-identity'})
  } finally { if (previous === undefined) delete process.env.DSH_TEST_SECRET; else process.env.DSH_TEST_SECRET = previous }
  const options = profiles.activate(account,{})
  const env = profileEnvironment(options.managedAccount.env)
  assert.equal(env.HOME,options.zcodeDataBaseDir)
  assert.equal(env.ZCODE_CREDENTIALS_FILE,path.join(options.zcodeDataBaseDir,'.zcode','v2','credentials.json'))
  assert.equal(fs.readFileSync(path.join(legacy,'source.json'),'utf8'),'old cache')
  assert.notEqual(profiles.directory('one'),profiles.directory('ONE'))
  assert.throws(()=>profiles.activate({...account,identityHash:'other'},{}),/account-login-required/)
  const previousRoot = options.zcodeDataBaseDir
  await assert.rejects(profiles.login({zcodeCliNode:process.execPath},{...account,userId:'wrong'},'zai'),/account-identity-mismatch/)
  assert.equal(profiles.activate(account,{}).zcodeDataBaseDir,previousRoot)
  const linked = path.join(scratch,'linked-secret')
  fs.linkSync(env.ZCODE_CREDENTIAL_SECRET_FILE,linked)
  assert.throws(()=>profiles.activate(account,{}),/account-profile-boundary/)
  fs.unlinkSync(linked)
  if (process.platform === 'win32') {
    const icacls = path.join(process.env.SystemRoot,'System32','icacls.exe')
    execFileSync(icacls,[env.ZCODE_CREDENTIAL_SECRET_FILE,'/grant','*S-1-1-0:(R)'],{stdio:'ignore'})
    assert.throws(()=>profileEnvironment(options.managedAccount.env),error =>
      error.code === 'account-profile-permissions' && error.message.includes('unexpected allow rule'))
  }
  fs.unlinkSync(env.ZCODE_CREDENTIALS_FILE)
  assert.throws(()=>profiles.activate(account,{}),/account-login-required/)
})

test('older metadata requires explicit binding and login failures never leave a success receipt', async t => {
  const {cli,root,profiles} = harness(t)
  const unknown = {id:'other',provider:'unknown',identityHash:''}
  await assert.rejects(profiles.login({},unknown,'bigmodel'),/account-identity-unavailable/)
  await assert.rejects(profiles.login({},member,'bigmodel'),/account-provider-mismatch/)
  const signed = await profiles.login({bindUnverified:true,zcodeCliNode:process.execPath},unknown,'bigmodel')
  assert.equal(signed.binding,'user-selected')
  assert.equal(profiles.activate(unknown,{}).managedAccount.provider,'bigmodel')
  const original = profiles.activate(unknown,{})
  const bad = new ZSwitchProfiles({root,cli:()=>cli,run:async()=>{throw new Error('account-login-failed')}})
  await assert.rejects(bad.login({bindUnverified:true},unknown,'bigmodel'),/account-login-failed/)
  assert.equal(profiles.activate(unknown,{}).managedAccount.provider,'bigmodel')
  await assert.rejects(profiles.login({zcodeCliNode:process.execPath},{...member,userId:'wrong'},'zai'),/account-identity-mismatch/)
  assert.throws(()=>profiles.activate(member,{}),/account-login-required/)
  assert.equal(profiles.activate(unknown,{}).zcodeDataBaseDir,original.zcodeDataBaseDir)
  await profiles.login({bindUnverified:true,zcodeCliNode:process.execPath},unknown,'bigmodel')
  assert.notEqual(profiles.activate(unknown,{}).zcodeDataBaseDir,original.zcodeDataBaseDir)
  assert.equal(fs.existsSync(original.managedAccount.env.ZCODE_CREDENTIALS_FILE),true)
})

test('linked roots, credentials and secrets are rejected before launching the CLI', async t => {
  const {profiles,scratch,root} = harness(t)
  const outside = path.join(scratch,'outside')
  fs.mkdirSync(outside); fs.mkdirSync(root)
  fs.symlinkSync(outside,profiles.directory(member.id),process.platform==='win32'?'junction':'dir')
  await assert.rejects(profiles.login({},member,'zai'),/account-profile-boundary/)
  assert.deepEqual(fs.readdirSync(outside),[])
  const absentCli = path.join(scratch,'unofficial','vendor','zcode.cjs')
  assert.notEqual((()=>{try{return isolatedCli(absentCli)}catch{return ''}})(),absentCli)
})


test('two completed logins racing for one revision publish only one private generation', async t => {
  const {cli,root} = harness(t)
  let firstStarted, releaseFirst
  const waiting = new Promise(resolve=>{firstStarted=resolve})
  const gate = new Promise(resolve=>{releaseFirst=resolve})
  let calls = 0
  const profiles = new ZSwitchProfiles({root,cli:()=>cli,run:async(_cli,_node,provider,env)=>{
    fs.writeFileSync(env.ZCODE_CREDENTIALS_FILE,'opaque')
    if (++calls === 1) { firstStarted(); await gate }
    return {status:'ready',provider,user:{user_id:'first'},credentialsPath:env.ZCODE_CREDENTIALS_FILE}
  }})
  const first = profiles.login({},member,'zai')
  await waiting
  await profiles.login({},member,'zai')
  const winning = profiles.activate(member,{})
  releaseFirst()
  await assert.rejects(first,/stale-state/)
  assert.equal(profiles.activate(member,{}).zcodeDataBaseDir,winning.zcodeDataBaseDir)
  assert.deepEqual(fs.readdirSync(profiles.directory(member.id)).sort(),[winning.managedAccount.generation,'login-1'].sort())
})
