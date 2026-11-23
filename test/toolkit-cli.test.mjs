import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
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

test('login requires a local account ID and an explicit supported provider before launch', () => {
  for (const args of [
    [], ['--account', 'local'], ['--account', '--provider', 'zai'],
    ['--account', 'local', '--provider', 'other'], ['--account', '../local', '--provider', 'bigmodel'],
    ['--account', 'local', '--provider', 'zai', '--data-dir', './shared'],
    ['--account', 'local', '--provider', 'bigmodel', '--bind-unverified', '--bind-unverified'],
  ]) {
    const result = spawnSync(process.execPath, [bin, 'login', ...args], { encoding: 'utf8', timeout: 5000 })
    assert.equal(result.status, 2, result.stderr)
    assert.match(result.stdout, /login --account <id> --provider zai\|bigmodel/)
  }
})

test('models uses the requested data root and lists only native Start Plan routes', t => {
  const scratch = fileURLToPath(new URL('../../work/zcode-toolkit-20261114/', import.meta.url))
  fs.mkdirSync(scratch, { recursive: true })
  const root = fs.mkdtempSync(path.join(scratch, 'cli-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const cli = path.join(root, 'zcode.cjs')
  fs.writeFileSync(cli, `
    const assert = require('node:assert/strict')
    const fs = require('node:fs')
    assert.equal(process.env.ZCODE_DATA_BASE_DIR, __dirname)
    assert.equal(process.env.ZCODE_CREDENTIAL_SECRET, undefined)
    const providers = fs.existsSync(__dirname + '/empty') ? ['metered'] : ['metered', 'account:zai-start-plan', 'account:bigmodel-start-plan']
    const available = providers.map(providerId => ({ ref: { providerId, modelId: 'same' } }))
    require('node:readline').createInterface({ input: process.stdin }).on('line', text => {
      const { id, method } = JSON.parse(text)
      assert.ok(['session/create', 'session/close'].includes(method))
      console.log(JSON.stringify({ id, result: { session: { sessionId: 'fixture' }, settings: { model: { available } } } }))
    })
  `)
  const invoke = () => spawnSync(process.execPath, [bin, 'models', '--json', '--cli-path', cli, '--account-mode', 'start-plan', '--data-dir', root],
    { encoding: 'utf8', timeout: 5000, env: { ...process.env, ZCODE_CREDENTIAL_SECRET: 'fixture' } })
  let result = invoke()
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout).facts.models.map(entry => entry.providerId), ['account:zai-start-plan', 'account:bigmodel-start-plan'])
  fs.writeFileSync(path.join(root, 'empty'), '')
  result = invoke()
  assert.equal(result.status, 1)
  assert.equal(JSON.parse(result.stdout).ok, false)
})
