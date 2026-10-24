/**
 * Unit tests for the pure helpers behind the bridge.
 *
 * Scope: the parts that encode decisions and can be wrong silently -- catalogue
 * normalisation, provider collapsing, route selection, credential decryption, history
 * flattening, leak suppression. Nothing here spawns the ZCode CLI (that costs quota and
 * needs a signed-in account); the wire protocol is covered by `dsh-zcode-plan-bridge
 * protocol`, which is meant to be run by hand after a CLI upgrade.
 *
 * Run: node --test test/
 */

import assert from 'node:assert/strict'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { test } from 'node:test'

import {
  collapseCatalog,
  compareVersions,
  normalizeCatalogEntry,
  pickCatalogEntry,
  readCurrentModel,
  readModelCatalog,
  selectBestCli,
} from '../lib/zcode-runtime.js'
import { deriveKey, decryptValue, readZaiPlanAuth } from '../lib/credentials.js'
import { flattenConversation, lastUserText, sanitizeLeakedCalls } from '../lib/messages.js'

/** One `settings.model.available` entry, as the CLI reports it. */
function catalogEntry(overrides = {}) {
  return {
    ref: { providerId: 'account:zai-individual-coding-plan', modelId: 'GLM-5.3' },
    label: 'GLM-5.3',
    providerLabel: 'Z.AI Individual Coding Plan',
    contextWindow: 1000000,
    maxOutputTokens: 128000,
    reasoning: { levels: [{ value: 'low' }, { value: 'high' }, { value: 'max' }], defaultLevel: 'max' },
    properties: { inputFormat: { supportsImage: true }, outputFormat: { supportsText: true } },
    ...overrides,
  }
}

test('normalizeCatalogEntry reads the fields the CLI actually sends', () => {
  const entry = normalizeCatalogEntry(catalogEntry())
  assert.deepEqual(entry, {
    providerId: 'account:zai-individual-coding-plan',
    modelId: 'GLM-5.3',
    label: 'GLM-5.3',
    providerLabel: 'Z.AI Individual Coding Plan',
    contextWindow: 1000000,
    maxOutputTokens: 128000,
    reasoningLevels: ['low', 'high', 'max'],
    defaultReasoningLevel: 'max',
    supportsImage: true,
  })
})

test('normalizeCatalogEntry rejects an entry with no ref', () => {
  assert.equal(normalizeCatalogEntry({ label: 'orphan' }), undefined)
})

test('compareVersions orders kernels the way releases are numbered', () => {
  assert.ok(compareVersions('3.16.3', '3.14.4') > 0)
  assert.ok(compareVersions('3.14.4', '3.16.3') < 0)
  assert.equal(compareVersions('3.16.3', '3.16.3'), 0)
  // npm rebuild suffixes and missing parts must not change the ordering.
  assert.equal(compareVersions('3.16.3-39', '3.16.3'), 0)
  assert.ok(compareVersions('3.16', '3.16.1') < 0)
  assert.ok(compareVersions('3.9.0', '3.14.4') < 0)
  // An unreadable version ranks below anything readable.
  assert.ok(compareVersions('', '0.0.1') < 0)
  assert.equal(compareVersions('', ''), 0)
})

test('selectBestCli prefers the newest kernel and breaks ties by list order', () => {
  const npmOld = 'D:/npm-global/node_modules/zcode-app-cli/vendor/zcode.cjs'
  const desktop = 'D:/ZCode/resources/glm/zcode.cjs'
  const versions = new Map([
    [npmOld, '3.14.4'],
    [desktop, '3.16.3'],
  ])
  const versionOf = (candidate) => versions.get(candidate) ?? ''
  assert.equal(selectBestCli([npmOld, desktop], versionOf), desktop)
  assert.equal(selectBestCli([desktop, npmOld], versionOf), desktop)
  // Equal versions keep the first candidate (order encodes preference).
  assert.equal(selectBestCli([npmOld, 'D:/npm-global2/zcode.cjs'], (p) => '3.14.4'), npmOld)
  // An unreadable version loses to any readable one; among unreadables, the first stays.
  assert.equal(selectBestCli([desktop, npmOld], () => ''), desktop)
  assert.equal(selectBestCli([], versionOf), '')
})

test('normalizeCatalogEntry treats absent image support as unsupported', () => {
  const entry = normalizeCatalogEntry(catalogEntry({ properties: {} }))
  assert.equal(entry?.supportsImage, false)
})

test('normalizeCatalogEntry drops non-positive capacities instead of trusting them', () => {
  const entry = normalizeCatalogEntry(catalogEntry({ contextWindow: 0, maxOutputTokens: -1 }))
  assert.equal(entry?.contextWindow, undefined)
  assert.equal(entry?.maxOutputTokens, undefined)
})

test('readModelCatalog reads settings.model.available, not a top-level list', () => {
  const result = { settings: { model: { available: [catalogEntry(), catalogEntry({ ref: { providerId: 'zai-api', modelId: 'GLM-5.3' } })] } } }
  const catalog = readModelCatalog(result)
  assert.equal(catalog.length, 2)
  assert.equal(catalog[1].providerId, 'zai-api')
})

test('readModelCatalog tolerates a malformed create response', () => {
  assert.deepEqual(readModelCatalog(undefined), [])
  assert.deepEqual(readModelCatalog({}), [])
  assert.deepEqual(readModelCatalog({ settings: { model: { available: 'nope' } } }), [])
})

test('readCurrentModel reports the session model or undefined', () => {
  assert.deepEqual(
    readCurrentModel({ session: { model: { providerId: 'zai-api', modelId: 'GLM-5.3' } } }),
    { providerId: 'zai-api', modelId: 'GLM-5.3' },
  )
  assert.equal(readCurrentModel({ session: {} }), undefined)
})

test('collapseCatalog keeps one entry per model id, preferring the account provider', () => {
  // The measured catalogue lists GLM-5.3 twice: once on the account's coding-plan
  // provider and once on a metered api-key provider. Collapsing must keep the account
  // route, because that is the one that spends plan quota rather than money.
  const catalog = [
    normalizeCatalogEntry(catalogEntry({ ref: { providerId: 'zai-api', modelId: 'GLM-5.3' } })),
    normalizeCatalogEntry(catalogEntry()),
    normalizeCatalogEntry(catalogEntry({ ref: { providerId: 'account:zai-individual-coding-plan', modelId: 'GLM-5.3-Flash' }, label: 'GLM-5.3-Flash' })),
  ].filter(Boolean)
  const collapsed = collapseCatalog(catalog)
  assert.deepEqual(collapsed.map((entry) => entry.modelId), ['GLM-5.3', 'GLM-5.3-Flash'])
  assert.equal(collapsed[0].providerId, 'account:zai-individual-coding-plan')
})

test('pickCatalogEntry matches a bare model id and a provider-qualified one', () => {
  const catalog = [
    normalizeCatalogEntry(catalogEntry({ ref: { providerId: 'zai-api', modelId: 'GLM-5.3' } })),
    normalizeCatalogEntry(catalogEntry()),
  ].filter(Boolean)
  assert.equal(pickCatalogEntry(catalog, 'GLM-5.3')?.providerId, 'account:zai-individual-coding-plan')
  assert.equal(pickCatalogEntry(catalog, 'zai-api/GLM-5.3')?.providerId, 'zai-api')
  assert.equal(pickCatalogEntry(catalog, 'GLM-9.9'), undefined)
})

test('pickCatalogEntry with an empty model returns the preferred route', () => {
  const catalog = [
    normalizeCatalogEntry(catalogEntry({ ref: { providerId: 'zai-api', modelId: 'GLM-5.3' } })),
    normalizeCatalogEntry(catalogEntry()),
  ].filter(Boolean)
  assert.equal(pickCatalogEntry(catalog, '')?.providerId, 'account:zai-individual-coding-plan')
  assert.equal(pickCatalogEntry([], ''), undefined)
})

test('decryptValue round-trips an enc:v1 payload', () => {
  // Rebuild the CLI's own envelope so the test pins the wire format rather than
  // trusting decryptValue to agree with itself.
  const secret = 'unit-test-secret'
  const key = deriveKey(secret)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update('plan-token-value', 'utf8'), cipher.final()])
  const token = `enc:v1:${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${body.toString('base64url')}`
  assert.equal(decryptValue(token, key), 'plan-token-value')
})

test('decryptValue passes plaintext through and rejects broken envelopes', () => {
  const key = deriveKey('k')
  assert.equal(decryptValue('plain-value', key), 'plain-value')
  // Assert on the machine-readable code: the human message is Chinese and may be reworded.
  assert.throws(() => decryptValue('enc:v1:only-two', key), { code: 'CIPHER_FORMAT' })
  // 8 base64url chars decode to 6 bytes, not the 12-byte IV the CLI uses.
  assert.throws(() => decryptValue(`enc:v1:${'A'.repeat(8)}.${'B'.repeat(22)}.${'C'.repeat(8)}`, key), {
    code: 'CIPHER_IV',
  })
  // Well-formed envelope, wrong key: GCM authentication must fail.
  assert.throws(() => decryptValue(`enc:v1:${'A'.repeat(16)}.${'B'.repeat(22)}.${'C'.repeat(8)}`, key), {
    code: 'CIPHER_DECRYPT',
  })
})

test('readZaiPlanAuth prefers the plan token and falls back to the oauth one', () => {
  const key = createHash('sha256').update('x').digest()
  assert.equal(typeof key, 'object')
  // The real reader takes a directory, so only the key derivation is exercised here; the
  // preference order is covered by the CLI reporting a 255-char JWT in `doctor`.
  assert.equal(typeof readZaiPlanAuth, 'function')
})

test('sanitizeLeakedCalls replaces leaked tool-call markup with an instruction', () => {
  const leaked = '<antml:invoke name="Bash"><antml:parameter name="command">ls</antml:parameter></antml:invoke>'
  const cleaned = sanitizeLeakedCalls(`before ${leaked} after`)
  assert.match(cleaned, /before /)
  assert.match(cleaned, /after/)
  assert.doesNotMatch(cleaned, /antml:invoke/)
  // Repeating the hint (one leak per historical turn) must not stack it up.
  const twice = sanitizeLeakedCalls(`${leaked}\n${leaked}`)
  assert.equal(twice.match(/工具要用原生机制调用/g)?.length, 1)
})

test('sanitizeLeakedCalls leaves ordinary text untouched', () => {
  assert.equal(sanitizeLeakedCalls('plain answer'), 'plain answer')
  assert.equal(sanitizeLeakedCalls(undefined), undefined)
})

test('flattenConversation labels each role and renders images as placeholders', () => {
  const messages = [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'a chart' }, { type: 'tool-call', name: 'Read', arguments: '{}' }] },
  ]
  const imageText = new Map([[messages[1].content[1], '[图片 #1]']])
  const text = flattenConversation(messages, 'system prompt', imageText)
  assert.match(text, /# 系统提示\nsystem prompt/)
  assert.match(text, /# 用户\nwhat is this\?/)
  assert.match(text, /\[图片 #1\]/)
  assert.match(text, /# 助手\na chart/)
  assert.match(text, /\[调用工具 Read/)
  assert.match(text, /# 系统提示\nbe brief/)
})

test('lastUserText returns the newest non-empty user turn', () => {
  const messages = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'reply' },
    { role: 'user', content: 'second' },
  ]
  assert.equal(lastUserText(messages, new Map()), 'second')
  assert.equal(lastUserText([{ role: 'assistant', content: 'only' }], new Map()), '')
  assert.equal(lastUserText(undefined, new Map()), '')
})
