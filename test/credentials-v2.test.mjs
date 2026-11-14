import assert from 'node:assert/strict'
import test from 'node:test'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decryptValue, readZaiPlanAuth } from '../lib/credentials.js'

const key = createHash('sha256').update('synthetic-v2-key-never-a-real-credential').digest()
const fingerprint = createHash('sha256').update(key).digest('hex').slice(0, 24)
function seal(text, source = 'os') {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(text), cipher.final()])
  return `enc:v2:${source}:${fingerprint}:${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${body.toString('base64url')}`
}
test('v2 envelopes decrypt with their exact key fingerprint and never pass ciphertext through', () => {
  assert.equal(decryptValue(seal('bigmodel'), key), 'bigmodel')
  assert.throws(() => decryptValue(seal('token'), randomBytes(32)), { code: 'CIPHER_KEY' })
  assert.throws(() => decryptValue('enc:v9:unknown', key), { code: 'CIPHER_VERSION' })
  assert.throws(() => decryptValue('enc:v2:os:malformed', key), { code: 'CIPHER_FORMAT' })
})
test('v2 OAuth reads the existing OS key once and never modifies credentials or key stores', t => {
  const scratch = process.env.ZCODE_TEST_SCRATCH || fileURLToPath(new URL('../../work/zcode-toolkit-20261114/', import.meta.url))
  fs.mkdirSync(scratch, { recursive: true })
  const dir = fs.mkdtempSync(path.join(scratch, 'credentials-v2-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const root = path.join(dir, '.zcode/v2'); fs.mkdirSync(root, { recursive: true })
  const file = path.join(root, 'credentials.json')
  fs.writeFileSync(file, JSON.stringify({ 'oauth:active_provider': seal('bigmodel'), zcodejwttoken: seal('fixture-token') }))
  const before = fs.readFileSync(file)
  let reads = 0
  const result = readZaiPlanAuth(dir, undefined, { readOsKey: target => { assert.equal(target, file); reads++; return key.toString('base64url') } })
  assert.equal(result.activeProvider, 'bigmodel'); assert.equal(result.planToken, 'fixture-token')
  assert.equal(reads, 1)
  assert.deepEqual(fs.readFileSync(file), before)
  assert.deepEqual(fs.readdirSync(root), ['credentials.json'])
  assert.throws(() => readZaiPlanAuth(dir, undefined, { readOsKey: () => null }), { code: 'CREDENTIAL_KEYSTORE' })
})

test('v2 explicit environment source uses the native untrimmed secret without touching a key store', t => {
  const scratch = process.env.ZCODE_TEST_SCRATCH || fileURLToPath(new URL('../../work/zcode-toolkit-20261114/', import.meta.url))
  fs.mkdirSync(scratch, { recursive: true })
  const dir = fs.mkdtempSync(path.join(scratch, 'credentials-v2-env-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const root = path.join(dir, '.zcode/v2'); fs.mkdirSync(root, { recursive: true })
  const prior = process.env.ZCODE_CREDENTIAL_SECRET, priorFile = process.env.ZCODE_CREDENTIAL_SECRET_FILE
  t.after(() => { if (prior === undefined) delete process.env.ZCODE_CREDENTIAL_SECRET; else process.env.ZCODE_CREDENTIAL_SECRET = prior; if (priorFile === undefined) delete process.env.ZCODE_CREDENTIAL_SECRET_FILE; else process.env.ZCODE_CREDENTIAL_SECRET_FILE = priorFile })
  process.env.ZCODE_CREDENTIAL_SECRET = 'synthetic-v2-key-never-a-real-credential'
  delete process.env.ZCODE_CREDENTIAL_SECRET_FILE
  fs.writeFileSync(path.join(root, 'credentials.json'), JSON.stringify({ 'oauth:active_provider': seal('zai', 'env'), zcodejwttoken: seal('fixture-token', 'env') }))
  assert.equal(readZaiPlanAuth(dir, undefined, { readOsKey: () => assert.fail('must not touch OS key store') }).activeProvider, 'zai')
  process.env.ZCODE_CREDENTIAL_SECRET = 'wrong-secret'
  assert.throws(() => readZaiPlanAuth(dir), { code: 'CREDENTIAL_KEYSTORE' })
})
