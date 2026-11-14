import assert from 'node:assert/strict'
import test from 'node:test'
import { ZcodeAppServerAdapter } from '../lib/app-server.js'

test('missing CLI is a terminal invalid configuration on rc.3', async () => {
  const adapter = new ZcodeAppServerAdapter({ options: () => ({ zcodeCliPath: new URL('./does-not-exist-cli', import.meta.url).pathname }) })
  await assert.rejects(adapter.client.start(), error => error.code === 'INVALID_CONFIG')
  adapter.dispose()
})

test('a rejected permission-mode change stops before generation with INVALID_CONFIG', async () => {
  const adapter = new ZcodeAppServerAdapter({ options: () => ({ authorizationPolicy: 'deny', appServerTimeoutMs: 1000 }) })
  const requests = []
  adapter.client.request = async method => { requests.push(method); throw new Error('fixture rejection') }
  await assert.rejects(adapter.syncAuthorizationMode('fixture-session', { authorizationPolicy: 'deny', appServerTimeoutMs: 1000 }), error => error.code === 'INVALID_CONFIG')
  assert.deepEqual(requests, ['session/setMode'])
  adapter.dispose()
})

test('a malformed session creation response reports INVALID_RESPONSE', async () => {
  const adapter = new ZcodeAppServerAdapter({ options: () => ({ authorizationPolicy: 'deny', appServerTimeoutMs: 1000, cliCwd: '' }) })
  adapter.client.ensureStarted = async () => {}
  adapter.client.request = async () => ({ session: {} })
  await assert.rejects(adapter.ensureSession('fixture-session', 'fixture-model'), error => error.code === 'INVALID_RESPONSE')
  assert.equal(adapter.sessions.size, 0)
  adapter.dispose()
})
