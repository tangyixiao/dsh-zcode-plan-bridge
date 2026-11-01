import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import * as attach from '../community/runtime/native-attach.mjs'
import * as owned from '../community/runtime/owned-inspector.mjs'

test('native identity collection never returns CLI prompt or arbitrary argument values', () => {
  assert.equal(typeof owned.nativeIdentityExpression, 'function', 'identity collection must return only safe fields')
  const fakeProcess = { pid: 42, execPath: 'C:/node/node.exe', argv: ['C:/node/node.exe', 'C:/npm/node_modules/zcode-app-cli/vendor/zcode.cjs', '--prompt', 'PRIVATE_PROMPT', '--prompt=PRIVATE_INLINE', 'PRIVATE_POSITIONAL'],
    versions: { node: '22.18.0' }, getBuiltinModule: () => ({ realpathSync: value => value, readFileSync: () => JSON.stringify({ name: 'zcode-app-cli', version: '3.17.1-42' }) }) }
  const identity = vm.runInNewContext(owned.nativeIdentityExpression(42), { process: fakeProcess, globalThis: {}, clearTimeout() {}, setTimeout: () => ({ unref() {} }), Number })
  assert.equal(JSON.stringify(identity).includes('PRIVATE_'), false)
  assert.equal(identity.pid, 42)
  assert.equal(identity.execPath, 'C:/node/node.exe')
})

test('CLI attachment accepts only the direct trusted npm kernel across app-server, prompt, and TUI modes', () => {
  assert.equal(typeof attach.resolveCliPackage, 'function')
  assert.equal(typeof attach.isCliAgent, 'function')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keeper-cli-identity-'))
  try {
    fs.mkdirSync(path.join(root, 'vendor')); fs.mkdirSync(path.join(root, 'bin'))
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'zcode-app-cli', version: '3.17.1-42' }))
    fs.writeFileSync(path.join(root, 'vendor', 'zcode.cjs'), '// installed kernel')
    fs.writeFileSync(path.join(root, 'bin', 'zcode.js'), '// installed entry')
    const cli = attach.resolveCliPackage(path.join(root, 'vendor', 'zcode.cjs'))
    const identity = { pid: 42, nodeMajor: 22, fetch: 'function', execPath: 'C:/node/node.exe', cliPath: cli.cliPath, packageName: 'zcode-app-cli', packageVersion: '3.17.1-42',
      argv: ['C:/node/node.exe', cli.cliPath, 'app-server', '--stdio', '--surface', 'terminal'] }
    assert.equal(attach.isCliAgent(identity, 42, cli), true)
    assert.equal(attach.isCliAgent(identity, 43, cli), false)
    assert.equal(attach.isCliAgent({ ...identity, argv: ['C:/node/node.exe', cli.cliPath] }, 42, cli), true, 'headless and TUI modes use the same verified kernel identity')
    assert.equal(attach.isCliAgent({ ...identity, packageVersion: 'other' }, 42, cli), false)
    assert.equal(attach.isCliAgent({ ...identity, execPath: 'C:/ZCode/ZCode.exe' }, 42, cli), false)
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'not-zcode', version: '3.17.1-42' }))
    assert.throws(() => attach.resolveCliPackage(cli.cliPath), /package|CLI/i)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
