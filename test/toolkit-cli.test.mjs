import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const bin = fileURLToPath(new URL('../bin/dsh-zcode-plan-bridge.js', import.meta.url))
for (const command of [['status', '--json'], ['capabilities', '--json'], ['doctor', '--share']]) {
  test(`local ${command.join(' ')} emits one safe JSON document without an agent`, () => {
    const result = spawnSync(process.execPath, [bin, ...command, '--cli-path', 'missing-private-path', '--account-mode', 'start-plan'], { encoding: 'utf8', timeout: 5000 })
    assert.equal(result.status, 0, result.stderr)
    const output = JSON.parse(result.stdout)
    assert.equal(output.inference, 'not-tested')
    assert.equal(output.accountMode, 'start-plan')
    assert.doesNotMatch(result.stdout, /missing-private-path|credentials\.json|planToken|accessToken|\\Users\\/)
  })
}
