import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { marketInstallTarget, parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'

import * as generator from './generate.mjs'
import * as metadata from './metadata.mjs'

const indexUrl = 'https://tangyixiao.github.io/dsh-zcode-plan-bridge/index.json'
const repositoryManifest = { name: 'dsh-zcode-plan-bridge', version: '0.5.2' }

function packument() {
  return {
    name: 'dsh-zcode-plan-bridge',
    'dist-tags': { latest: '0.5.1', next: '0.6.0-rc.1' },
    versions: {
      '0.5.1': { name: 'dsh-zcode-plan-bridge', version: '0.5.1' },
      '0.6.0-rc.1': { name: 'dsh-zcode-plan-bridge', version: '0.6.0-rc.1' },
      '0.5.2': {
        name: 'dsh-zcode-plan-bridge',
        version: '0.5.2',
        author: { name: 'kyle123740' },
        description: 'A ZCode provider published by the package author.',
        homepage: 'https://github.com/tangyixiao/dsh-zcode-plan-bridge#readme',
        repository: { type: 'git', url: 'git+https://github.com/tangyixiao/dsh-zcode-plan-bridge.git' },
        keywords: ['dsh-plugin', 'zcode'],
        engines: { dsh: '>=0.1.5 <0.3.0-0 || ^0.2.1-rc.1' },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      },
    },
    time: { '0.5.2': '2026-10-30T13:25:25.484Z' },
  }
}

test('indexes the repository release through the official reader and pinned npm installer', () => {
  assert.equal(typeof metadata.buildMarketIndex, 'function')
  const index = parseMarketIndex(metadata.buildMarketIndex(packument(), repositoryManifest), indexUrl)
  assert.equal(index.plugins.length, 1)
  const plugin = index.plugins[0]
  assert.equal(plugin.name, 'dsh-zcode-plan-bridge')
  assert.deepEqual(plugin.versions.map((version) => version.version), ['0.5.2'])
  assert.deepEqual(marketInstallTarget(plugin.name, plugin.versions[0]), {
    spec: 'dsh-zcode-plan-bridge@0.5.2',
    registry: 'https://registry.npmjs.org/',
  })
  assert.equal(plugin.author, 'kyle123740')
  assert.equal(plugin.description, 'A ZCode provider published by the package author.')
  assert.equal(plugin.homepage, 'https://github.com/tangyixiao/dsh-zcode-plan-bridge#readme')
  assert.deepEqual(plugin.repository, { url: 'https://github.com/tangyixiao/dsh-zcode-plan-bridge' })
  assert.equal(plugin.versions[0].publishTimestamp, 1793366725)
  assert.equal(plugin.versions[0].engines.dsh, '>=0.1.5 <0.3.0-0 || ^0.2.1-rc.1')
})

test('accepts the string author form without replacing the package author', () => {
  const registry = packument()
  registry.versions['0.5.2'].author = 'kyle123740'
  assert.equal(metadata.buildMarketIndex(registry, repositoryManifest).plugins[0].author, 'kyle123740')
})

test('rejects registry data that cannot describe the fixed published bundle', () => {
  const cases = [
    ['wrong registry name', (registry) => { registry.name = 'someone-elses-plugin' }, /registry package name/i],
    ['missing version', (registry) => { delete registry.versions['0.5.2'] }, /0\.5\.2.*not published/i],
    ['unpublished package', (registry) => { registry.time.unpublished = { time: '2026-10-31T00:00:00.000Z' } }, /unpublished/i],
    ['wrong manifest name', (registry) => { registry.versions['0.5.2'].name = 'someone-elses-plugin' }, /manifest name/i],
    ['wrong manifest version', (registry) => { registry.versions['0.5.2'].version = '0.5.1' }, /manifest version/i],
    ['private package', (registry) => { registry.versions['0.5.2'].private = true }, /public/i],
    ['deprecated package', (registry) => { registry.versions['0.5.2'].deprecated = 'Do not install' }, /deprecated/i],
    ['missing bundle', (registry) => { delete registry.versions['0.5.2'].dsh }, /dsh\.bundle\.patch/i],
    ['empty bundle patch', (registry) => { registry.versions['0.5.2'].dsh.bundle.patch = ' ' }, /dsh\.bundle\.patch/i],
    ['non-string bundle patch', (registry) => { registry.versions['0.5.2'].dsh.bundle.patch = {} }, /dsh\.bundle\.patch/i],
    ['wrong repository', (registry) => { registry.versions['0.5.2'].repository.url = 'https://github.com/other/repo' }, /repository/i],
  ]
  for (const [label, mutate, errorPattern] of cases) {
    const registry = packument()
    mutate(registry)
    assert.throws(() => metadata.buildMarketIndex(registry, repositoryManifest), errorPattern, label)
  }
})

test('rejects invalid publication times instead of substituting the build time', () => {
  for (const timestamp of [undefined, 'not-a-date', -1, '1969-01-01T00:00:00.000Z']) {
    const registry = packument()
    registry.time['0.5.2'] = timestamp
    assert.throws(() => metadata.buildMarketIndex(registry, repositoryManifest), /time|Timestamp/i)
  }
})

test('requires valid top-level DSH compatibility instead of silently declaring any host compatible', () => {
  for (const compatibility of [undefined, '', 'not a semver range', 'workspace:*']) {
    const registry = packument()
    registry.versions['0.5.2'].engines.dsh = compatibility
    registry.versions['0.5.2'].dsh.engines = { dsh: '^0.2.1' }
    assert.throws(() => metadata.buildMarketIndex(registry, repositoryManifest), /engines\.dsh/i)
  }
})

test('rejects a preview, malformed, or unrelated repository manifest', () => {
  for (const manifest of [
    { name: 'another-package', version: '0.5.2' },
    { name: 'dsh-zcode-plan-bridge', version: '0.6.0-rc.1' },
    { name: 'dsh-zcode-plan-bridge', version: 'latest' },
    { name: 'dsh-zcode-plan-bridge' },
  ]) {
    assert.throws(() => metadata.buildMarketIndex(packument(), manifest), /name|version|stable/i)
  }
})

async function fixturePaths(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-author-index-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const manifestPath = path.join(directory, 'package.json')
  const outputPath = path.join(directory, 'dist', 'index.json')
  await writeFile(manifestPath, JSON.stringify(repositoryManifest))
  return { manifestPath, outputPath }
}

test('generator fetches public metadata and writes an index the official installer consumes', async (t) => {
  assert.equal(typeof generator.generateIndex, 'function')
  const paths = await fixturePaths(t)
  await generator.generateIndex({
    ...paths,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://registry.npmjs.org/dsh-zcode-plan-bridge')
      assert.equal(options.headers['cache-control'], 'no-cache')
      assert.equal(options.headers.authorization, undefined)
      assert.equal(options.credentials, 'omit')
      assert.equal(options.redirect, 'error')
      assert.ok(options.signal instanceof AbortSignal)
      return Response.json(packument())
    },
    attempts: 1,
  })
  const index = parseMarketIndex(JSON.parse(await readFile(paths.outputPath, 'utf8')), indexUrl)
  assert.equal(index.plugins.length, 1)
  const plugin = index.plugins[0]
  assert.deepEqual(marketInstallTarget(plugin.name, plugin.versions[0]), {
    spec: 'dsh-zcode-plan-bridge@0.5.2',
    registry: 'https://registry.npmjs.org/',
  })
})

test('waits for the repository version to propagate without falling back to stale latest', async (t) => {
  const paths = await fixturePaths(t)
  let responses = 0
  await generator.generateIndex({
    ...paths,
    attempts: 3,
    retryDelayMs: 0,
    fetchImpl: async () => {
      responses += 1
      if (responses === 1) return new Response('Not found', { status: 404 })
      const registry = packument()
      if (responses === 2) delete registry.versions['0.5.2']
      return Response.json(registry)
    },
  })
  const index = parseMarketIndex(JSON.parse(await readFile(paths.outputPath, 'utf8')), indexUrl)
  assert.equal(responses, 3)
  assert.deepEqual(index.plugins[0].versions.map((version) => version.version), ['0.5.2'])
})

test('exhausted publication retries leave the previous output intact', async (t) => {
  const paths = await fixturePaths(t)
  await mkdir(path.dirname(paths.outputPath))
  await writeFile(paths.outputPath, 'previous accepted output\n')
  let responses = 0
  await assert.rejects(generator.generateIndex({
    ...paths,
    attempts: 2,
    retryDelayMs: 0,
    fetchImpl: async () => {
      responses += 1
      const registry = packument()
      delete registry.versions['0.5.2']
      return Response.json(registry)
    },
  }), /0\.5\.2.*not published/i)
  assert.equal(responses, 2)
  assert.equal(await readFile(paths.outputPath, 'utf8'), 'previous accepted output\n')
})

test('invalid published metadata fails immediately without replacing previous output', async (t) => {
  const paths = await fixturePaths(t)
  await mkdir(path.dirname(paths.outputPath))
  await writeFile(paths.outputPath, 'previous accepted output\n')
  let responses = 0
  await assert.rejects(generator.generateIndex({
    ...paths,
    attempts: 3,
    retryDelayMs: 0,
    fetchImpl: async () => {
      responses += 1
      const registry = packument()
      registry.versions['0.5.2'].engines.dsh = 'invalid'
      return Response.json(registry)
    },
  }), /engines\.dsh/i)
  assert.equal(responses, 1)
  assert.equal(await readFile(paths.outputPath, 'utf8'), 'previous accepted output\n')
})

test('non-publication HTTP failures fail instead of publishing a partial index', async (t) => {
  const paths = await fixturePaths(t)
  await assert.rejects(generator.generateIndex({
    ...paths,
    attempts: 1,
    fetchImpl: async () => new Response('Unavailable', { status: 503 }),
  }), /503/)
  await assert.rejects(readFile(paths.outputPath), { code: 'ENOENT' })
})
