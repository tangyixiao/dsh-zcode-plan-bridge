import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveOptions } from '../lib/index.js'
import { ZcodeAppServerAdapter } from '../lib/app-server.js'
import { communityLaunch } from '../lib/community-retry.js'

test('community retry is off by default and leaves original launch/policy intact', () => {
  const options = resolveOptions({})
  assert.equal(options.communityRetry.enabled, false)
  const launch = communityLaunch(options.communityRetry, 'original.cjs')
  assert.deepEqual(launch.args, ['original.cjs']); assert.deepEqual(launch.env, {})
  const adapter = new ZcodeAppServerAdapter({ options: () => options })
  assert.deepEqual(adapter.providerRetryPolicy(), options.retryPolicy)
})

test('enabled bridge launches shared bootstrap and disables outer retry', () => {
  const options = resolveOptions({ communityRetry: { enabled: true, maxRetries: 2, baseDelayMs: 7 } })
  const launch = communityLaunch(options.communityRetry, 'original.cjs')
  assert.match(launch.args[0], /agent\.cjs$/)
  assert.deepEqual(launch.args.slice(1), ['--cli', 'original.cjs'])
  assert.equal(JSON.parse(launch.env.ZCODE_COMMUNITY_RETRY_CONFIG_JSON).maxRetries, 2)
  assert.equal(launch.env.ZCODE_MODEL_RETRY_MAX_RETRIES, '0')
  const adapter = new ZcodeAppServerAdapter({ options: () => options })
  assert.equal(adapter.providerRetryPolicy().maxRetries, 0)
})

test('invalid retry options are rejected and running child retains its policy snapshot', () => {
  assert.throws(() => resolveOptions({ communityRetry: { enabled: true, maxRetries: -1 } }))
  assert.throws(() => resolveOptions({ communityRetry: { enabled: 'yes' } }))
  let options = resolveOptions({ communityRetry: { enabled: true } })
  const adapter = new ZcodeAppServerAdapter({ options: () => options })
  adapter.client.child = {}; adapter.client.communityRetryEnabled = true
  options = resolveOptions({ communityRetry: { enabled: false }, retryPolicy: { mode: 'normal', maxRetries: 6 } })
  assert.equal(adapter.providerRetryPolicy().maxRetries, 0)
  adapter.client.child = undefined
  assert.equal(adapter.providerRetryPolicy().maxRetries, 6)
})
