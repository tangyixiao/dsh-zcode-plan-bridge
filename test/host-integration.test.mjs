import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import bridge from '../lib/index.js'

test('registers and disposes zcode-cli with the DSH 0.2.2 host runtime', async () => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const fiber = ctx.plugin(bridge, { zcodeCliPath: process.execPath })
  await fiber
  assert.ok(ctx.llm.listProviders().some(provider => provider.id === 'zcode-cli'))
  await fiber.dispose()
  assert.ok(!ctx.llm.listProviders().some(provider => provider.id === 'zcode-cli'))
  await ctx.fiber.dispose()
})
