import assert from 'node:assert/strict'
import { test } from 'node:test'

import { modeForPolicy, permissionResponse } from '../lib/authorization.js'
import { Config, resolveOptions } from '../lib/index.js'
import { ZcodeAppServerAdapter } from '../lib/app-server.js'

test('authorization policy defaults to deny and accepts explicit full-auto only', () => {
  assert.equal(Config({}).authorizationPolicy, 'deny')
  assert.equal(resolveOptions({}).authorizationPolicy, 'deny')
  assert.equal(Config({ authorizationPolicy: 'allow-all' }).authorizationPolicy, 'allow-all')
  assert.equal(resolveOptions({ authorizationPolicy: 'allow-all' }).authorizationPolicy, 'allow-all')
  assert.throws(() => Config({ authorizationPolicy: 'unexpected' }))
})

test('default policy denies a tool permission request', () => {
  assert.deepEqual(permissionResponse('interaction/requestPermission', 'deny'), {
    decision: 'deny',
    reason: 'Permission requests are denied by the plugin policy.',
  })
})

test('explicit full-auto policy allows only the known permission method', () => {
  assert.deepEqual(permissionResponse('interaction/requestPermission', 'allow-all'), {
    decision: 'allow',
  })
  assert.deepEqual(permissionResponse('interaction/requestApproval', 'allow-all'), {
    decision: 'deny',
    reason: 'Unknown permission method; denied by the plugin policy.',
  })
})

test('unknown permission methods fail closed under every policy', () => {
  for (const policy of ['deny', 'allow-all']) {
    assert.deepEqual(permissionResponse('future/permissionCheck', policy), {
      decision: 'deny',
      reason: 'Unknown permission method; denied by the plugin policy.',
    })
  }
})

test('the user-once approval mode is answered by a bare decision', () => {
  assert.deepEqual(
    permissionResponse('interaction/requestPermission', 'allow-all', { approvalMode: 'user-once', options: [] }),
    { decision: 'allow' },
  )
  assert.deepEqual(
    permissionResponse('interaction/requestPermission', 'deny', { approvalMode: 'user-once' }),
    { decision: 'deny', reason: 'Permission requests are denied by the plugin policy.' },
  )
})

test('an unrecognized approval mode fails closed even in full-auto', () => {
  for (const policy of ['deny', 'allow-all']) {
    assert.deepEqual(permissionResponse('interaction/requestPermission', policy, { approvalMode: 'forever' }), {
      decision: 'deny',
      reason: 'Unknown approvalMode "forever"; denied by the plugin policy.',
    })
  }
})

test('a request without params behaves as before', () => {
  assert.deepEqual(permissionResponse('interaction/requestPermission', 'allow-all', undefined), {
    decision: 'allow',
  })
  assert.deepEqual(permissionResponse('interaction/requestPermission', 'allow-all', {}), {
    decision: 'allow',
  })
})

test('unrelated methods are not classified as permission requests', () => {
  assert.equal(permissionResponse('interaction/browserList', 'allow-all'), undefined)
})

test('both policies retain build mode so authorization requests reach the bridge', () => {
  assert.equal(modeForPolicy('deny'), 'build')
  assert.equal(modeForPolicy('allow-all'), 'build')
})

test('a permission mode switch failure stops the turn under either policy', async () => {
  for (const authorizationPolicy of ['deny', 'allow-all']) {
    const adapter = new ZcodeAppServerAdapter({
      options: () => ({ authorizationPolicy, appServerTimeoutMs: 5000 }),
      logger: { warn() {} },
    })
    adapter.client.request = async (method, params) => {
      assert.equal(method, 'session/setMode')
      assert.equal(params.mode, 'build')
      throw new Error('mode change rejected')
    }
    await assert.rejects(adapter.syncAuthorizationMode('session-1', {
      authorizationPolicy,
      appServerTimeoutMs: 5000,
    }), /已停止本轮/)
  }
})
