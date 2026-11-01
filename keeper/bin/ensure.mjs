#!/usr/bin/env node
import { ensureRetry, hookContext, safeFailure } from '../runtime/keeper.mjs'

// Hook stdin can contain the user's prompt. It is deliberately never consumed.
try {
  if (!['SessionStart', 'UserPromptSubmit'].includes(process.argv[2])) throw new Error('Unsupported Keeper hook event')
  await ensureRetry(hookContext())
} catch (error) {
  process.stdout.write(JSON.stringify({ continue: false, stopReason: `Retry Keeper: ${safeFailure(error)}` }) + '\n')
}
