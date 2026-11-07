import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveBuiltinRuntime } from '../../lib/zcode-runtime.js'

const targets = {
  'darwin/arm64': 'darwin-aarch64',
  'darwin/x64': 'darwin-x86_64',
  'linux/x64': 'linux-x86_64',
  'win32/x64': 'windows-x86_64',
}
const platform = `${process.platform}/${process.arch}`
const target = targets[platform]
assert.ok(target, `Unexpected runner ${platform}`)
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr13-native-'))
try {
  const file = path.join(root, '.zcode', 'v2', 'runtime', 'provider', target, '3.17.2', 'endpoint-test', 'zcode-builtin.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ revision: 43 }))
  const result = resolveBuiltinRuntime(root, '')
  assert.equal(result?.activeFilePath, file)
  assert.equal(result?.revision, 43)
  console.log(`Native ${platform} resolved ${target}`)
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
