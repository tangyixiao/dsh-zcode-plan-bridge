import assert from 'node:assert/strict'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(await readFile(path.join(root, '.github/toss.json'), 'utf8'))
const required = ['README.md', config.readme.secondary, 'AGENTS.md', 'CONTRIBUTING.md', 'SUPPORT.md', 'SECURITY.md', 'docs/maintenance.md', '.github/dependabot.yml', '.github/labels.json', '.github/release.yml', '.github/workflows/triage.yml', config.logo]
for (const filename of required) assert((await stat(path.join(root, filename))).isFile(), `Missing ${filename}`)
assert((await stat(path.join(root, config.logo))).size <= 256 * 1024, 'Logo exceeds the DSH 256 KiB limit')
const labels = JSON.parse(await readFile(path.join(root, '.github/labels.json'), 'utf8'))
assert.equal(new Set(labels.map(label => label.name)).size, labels.length, 'Duplicate repository labels')
for (const label of labels) assert(/^[0-9a-f]{6}$/i.test(label.color), `Invalid label color: ${label.name}`)
const workflows = (await readdir(path.join(root, '.github/workflows'))).filter(name => /\.ya?ml$/.test(name))
for (const name of workflows) {
  const content = await readFile(path.join(root, '.github/workflows', name), 'utf8')
  assert(!/\bwrite-all\b/.test(content), `${name}: broad token permissions`)
  assert(/permissions:/.test(content), `${name}: missing explicit permissions`)
  assert(/timeout-minutes:/.test(content), `${name}: missing timeout`)
  assert(/concurrency:/.test(content), `${name}: missing concurrency control`)
  for (const match of content.matchAll(/uses:\s*([^\s#]+)@([^\s#]+)/g)) assert(/^[a-f0-9]{40}$/.test(match[2]), `${name}: unpinned Action ${match[0]}`)
  if (/pull_request_target/.test(content)) {
    assert(!/actions\/checkout|\b(?:npm|pnpm|yarn)\s+(?:install|ci|run)|pull_request\.head|eval\(/.test(content), `${name}: privileged triage must not execute PR content`)
  }
}
let references = 0
for (const filename of ['README.md', config.readme.secondary, 'CONTRIBUTING.md', 'SUPPORT.md', 'SECURITY.md', 'docs/maintenance.md']) {
  const full = path.join(root, filename)
  const content = (await readFile(full, 'utf8')).replace(/```[\s\S]*?```/g, '')
  const targets = [...content.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)].map(match => match[1])
  for (const match of content.matchAll(/(?:src|srcset|href)="([^"]+)"/g)) targets.push(match[1])
  for (const target of targets) {
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) continue
    const relative = decodeURIComponent(target.split(/[?#]/)[0].replace(/^<|>$/g, ''))
    if (!relative) continue
    const resolved = path.resolve(path.dirname(full), relative)
    assert(resolved.startsWith(root + path.sep), `${filename}: reference leaves repository: ${target}`)
    await stat(resolved).catch(() => { throw new Error(`${filename}: missing local target ${target}`) })
    references++
  }
}
for (const filename of ['README.md', config.readme.secondary]) {
  const content = await readFile(path.join(root, filename), 'utf8')
  assert(content.includes(`repos=${config.repository}`), `${filename}: Star History points at another project`)
  assert(content.includes(`github/stars/${config.repository}`), `${filename}: Stars badge points at another project`)
}
if (config.distribution === 'npm') {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.icon, './assets/logo.webp')
  assert.equal(manifest.exports['./icon'], './assets/logo.webp')
  for (const file of ['assets/logo.webp', 'assets/NOTICE.md', 'assets/LICENSE-WHALE-ARTWORK']) assert(manifest.files.includes(file), `Package omits ${file}`)
}
console.log(`PASS ${config.repository}: ${workflows.length} pinned workflows, ${references} local documentation references, logo and distribution metadata`)
console.log('Local source validation only; GitHub settings, CI, publication and runtime activation require separate evidence.')
