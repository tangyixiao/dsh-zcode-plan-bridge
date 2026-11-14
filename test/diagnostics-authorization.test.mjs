import assert from 'node:assert/strict'
import { test } from 'node:test'

import { COMMANDS, TOOL_FLAG_NOTE } from '../lib/diagnostics.js'

/**
 * The diagnostics CLI spawns a real app-server agent with the user's account, so its
 * probes must follow the same fail-closed default as the plugin. These tests pin the
 * contract that makes that true without needing to spawn a process.
 */

test('the diagnostics help advertises the tool opt-in', () => {
  assert.match(TOOL_FLAG_NOTE, /--allow-tools/)
  assert.match(TOOL_FLAG_NOTE, /denied by default/)
})

test('every documented command is listed exactly once', () => {
  const names = COMMANDS.map((entry) => entry.name)
  assert.deepEqual(names, ['status', 'capabilities', 'doctor', 'models', 'protocol', 'turn', 'image'])
  assert.equal(new Set(names).size, names.length)
})

test('the commands that can run tools are the ones that start a turn', () => {
  // `turn` and `image` send real messages; they are the only probes whose tool requests
  // could ever reach a permission prompt. Pin that so a future command cannot quietly
  // be assumed safe.
  const spending = COMMANDS.filter((entry) => /spends quota/.test(entry.summary)).map((entry) => entry.name)
  assert.deepEqual(spending, ['turn', 'image'])
})
