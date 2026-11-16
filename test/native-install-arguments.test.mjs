import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { nativeInstallCall } from '../community/runtime/native-attach.mjs'

test('native retry installation passes paths and settings as CDP data, not constructed source',()=>{
  const payload='x");globalThis.injected=true;//\u2028\\'
  const params={dataDir:payload,pluginId:'zcode-community-retry@test',leaseFile:payload}
  const request=nativeInstallCall('functions-id',params,payload)
  assert.equal(request.objectId,'functions-id')
  assert.deepEqual(request.arguments,[{value:params},{value:payload}])
  assert.equal(request.functionDeclaration.includes(payload),false)
  const calls=[]
  class AiSdkModelExecution {resolveProviderTransport(){}bindModel(){}createFactory(){}}
  class AiSdkModelAdapter {streamTextWithResolved(){}generateTextWithResolved(){}}
  const runtime={resolveNativeSettingsFile:()=>'/synthetic/settings',installNativeRetry:a=>{calls.push(a);return{active:true}}}
  const context={process:{argv:['node','synthetic-agent'],mainModule:{require:name=>name==='node:fs'?{readFileSync:()=> 'globalThis.fetch ZCODE_MODEL_RETRY_MAX_RETRIES'}:runtime}}}
  const install=vm.runInNewContext(`(${request.functionDeclaration})`,context)
  assert.equal(install.call([AiSdkModelExecution,AiSdkModelAdapter],params,payload).active,true)
  assert.equal(calls[0].dataDir,payload)
  assert.equal(context.injected,undefined)
})
