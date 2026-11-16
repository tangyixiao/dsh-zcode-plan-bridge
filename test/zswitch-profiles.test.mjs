import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ZSwitchProfiles } from '../lib/zswitch-profiles.js'
import { readCredentials, credentialsPath } from '../lib/credentials.js'

test('independent profiles leave the shared login intact and preserve native refreshed credentials', t => {
  const scratch=fileURLToPath(new URL('../../work/zcode-multi-account-20261116/',import.meta.url))
  fs.mkdirSync(scratch,{recursive:true});const dir=fs.mkdtempSync(path.join(scratch,'profiles-'))
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const source=path.join(dir,'desktop'); const live=credentialsPath(source);fs.mkdirSync(path.dirname(live),{recursive:true});fs.writeFileSync(live,'{"original":"unchanged"}')
  const profile=new ZSwitchProfiles({root:path.join(dir,'managed'),secret:()=> 'a'.repeat(43),cli:()=>'/verified/npm/zcode.cjs',builtin:()=>({activeFilePath:'/verified/npm/provider/zcode-builtin.json',version:'3.18.1'})})
  const snap={id:'one',revision:'v1',sourceFile:live,sourceRoot:source,deviceMid:'existing-device',credentials:{'oauth:active_provider':'bigmodel',zcodejwttoken:'SECRET','oauth:bigmodel:user_info':'{"user_id":"one"}'}}
  const options=profile.activate(snap,{zcodeDataBaseDir:source,accountMode:'start-plan'})
  assert.notEqual(options.zcodeDataBaseDir,source)
  assert.equal(readCredentials(options.zcodeDataBaseDir,options.managedAccount.key).zcodejwttoken,'SECRET')
  const stored=fs.readFileSync(credentialsPath(options.zcodeDataBaseDir),'utf8'); assert.doesNotMatch(stored,/SECRET/)
  assert.equal(options.managedAccount.env.ZCODE_CLI_CREDENTIALS_FILE,credentialsPath(options.zcodeDataBaseDir))
  assert.equal(fs.readFileSync(live,'utf8'),'{"original":"unchanged"}')
  assert.equal(fs.existsSync(path.join(dir,'managed','credential-secret')),false)
  fs.writeFileSync(credentialsPath(options.zcodeDataBaseDir),stored.replace(/\}$/,' ,"native":"refreshed"}'))
  profile.activate(snap,{zcodeDataBaseDir:source,accountMode:'start-plan'})
  assert.equal(readCredentials(options.zcodeDataBaseDir,options.managedAccount.key).native,'refreshed')
  assert.equal(fs.readFileSync(live,'utf8'),'{"original":"unchanged"}')
})
test('independent selection refuses missing protected key storage instead of plaintext fallback',()=>{
  const profile=new ZSwitchProfiles({root:'/nonexistent/managed',secret:()=>{throw new Error('account-keyring-unavailable')},cli:()=>'/verified/npm/zcode.cjs'})
  assert.throws(()=>profile.activate({id:'one'},{}),/account-keyring-unavailable/)
})

test('independent cache refuses changed keys and destination directory links before writing', t => {
  const scratch=fileURLToPath(new URL('../../work/zcode-multi-account-20261116/',import.meta.url));fs.mkdirSync(scratch,{recursive:true})
  const dir=fs.mkdtempSync(path.join(scratch,'profile-boundary-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  let secret='a'.repeat(43)
  const root=path.join(dir,'managed'),desktop=path.join(dir,'desktop'),live=credentialsPath(desktop)
  fs.mkdirSync(path.dirname(live),{recursive:true});fs.writeFileSync(live,'ORIGINAL')
  const profile=new ZSwitchProfiles({root,secret:()=>secret,cli:()=>'/verified/npm/zcode.cjs',builtin:()=>({activeFilePath:'/verified/builtin.json'})})
  const snap={id:'one',revision:'v1',sourceFile:live,sourceRoot:desktop,credentials:{'oauth:active_provider':'bigmodel',zcodejwttoken:'SECRET'}}
  profile.activate(snap,{})
  secret='b'.repeat(43)
  assert.throws(()=>profile.activate(snap,{}),/account-profile-invalid/)
  fs.symlinkSync(desktop,path.join(root,'two'),process.platform==='win32'?'junction':'dir')
  assert.throws(()=>profile.activate({...snap,id:'two'},{}),/account-profile-boundary/)
  assert.equal(fs.readFileSync(live,'utf8'),'ORIGINAL')
})
