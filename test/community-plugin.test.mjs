import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createDesktopLaunch } from '../community/runtime/desktop.mjs'
import { loadConfig, saveConfig, readStatus, writeRuntime } from '../community/runtime/state.mjs'

test('configuration rejects unknown fields and persists atomically', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'retry-plugin-'))
  try {
    saveConfig(dir, { maxRetries: 2 }); assert.equal(loadConfig(dir).maxRetries, 2)
    assert.throws(() => saveConfig(dir, { secret: 'not allowed' }))
    assert.equal(loadConfig(dir).maxRetries, 2)
    assert.equal(readFileSync(path.join(dir, 'config.json'), 'utf8').includes('secret'), false)
    writeRuntime(dir, { state: 'loaded', pid: process.pid, version: '0.1.0', at: Date.now() })
    assert.equal(readStatus(dir).runtimes[0].live, true)
    writeRuntime(dir, { state: 'loaded', pid: 2147483647, version: '0.1.0', at: 0 })
    assert.equal(readStatus(dir).runtimes.find(r => r.pid === 2147483647).live, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('withdrawn desktop launcher fails before launching or replacing Agent commands', () => {
  const args = { executable: 'D:/Z Code/ZCode.exe', cli: 'D:/Z Code/resources/glm/zcode.cjs', node: process.execPath, dataDir: 'D:/retry data' }
  assert.throws(() => createDesktopLaunch(args, [{ name: 'ZCode.exe', pid: 1 }]), /launcher withdrawn/i)
  assert.throws(() => createDesktopLaunch(args, []), /launcher withdrawn/i)
})

test('MCP stdio supports initialize/config/status and rejects invalid configuration', { timeout: 10000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'retry-mcp-'))
  const child = spawn(process.execPath, ['community/bin/tools.mjs'], { cwd: process.cwd(), env: { ...process.env, ZCODE_COMMUNITY_RETRY_DATA: dir }, windowsHide: true })
  let sequence = 0, pending = new Map(), logs = ''
  child.stderr.on('data', b => { logs += b })
  createInterface({ input: child.stdout }).on('line', line => {
    const response = JSON.parse(line); pending.get(response.id)?.(response); pending.delete(response.id)
  })
  const request = (method, params) => new Promise(resolve => { const id = ++sequence; pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
  try {
    assert.equal((await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } })).result.serverInfo.name, 'zcode-community-retry')
    const listed = await request('tools/list', {})
    assert.deepEqual(listed.result.tools.map(t => t.name), ['retry_status', 'retry_configure'])
    assert.deepEqual(listed.result.tools[1].inputSchema.properties.mode.enum, ['unlimited', 'bounded'])
    const valid = await request('tools/call', { name: 'retry_configure', arguments: { mode: 'unlimited', intervalMs: 7000, maxRetries: 2 } })
    assert.equal(valid.result.isError, undefined)
    const invalid = await request('tools/call', { name: 'retry_configure', arguments: { maxRetries: -2 } })
    assert.equal(invalid.result.isError, true)
    const status = await request('tools/call', { name: 'retry_status', arguments: {} })
    assert.equal(status.result.structuredContent.config.maxRetries, 2)
    assert.equal(status.result.structuredContent.config.mode, 'unlimited')
    assert.equal(status.result.structuredContent.config.intervalMs, 7000)
    assert.equal(status.result.structuredContent.active, false)
    assert.equal(status.result.structuredContent.desktopIntegration.supported, false)
    assert.equal(status.result.structuredContent.launcher, undefined)
    assert.equal(logs, '')
  } finally { child.stdin.end(); await new Promise(r => child.once('exit', r)); rmSync(dir, { recursive: true, force: true }) }
})

test('Agent bootstrap writes a loaded runtime record without keeping the process alive', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'retry-state-'))
  try {
    const cli = path.join(dir, 'fake-cli.cjs')
    writeFileSync(cli, '// globalThis.fetch ZCODE_MODEL_RETRY_MAX_RETRIES\nprocess.stdout.write("CLI_OK")')
    const run = spawnSync(process.execPath, ['community/bin/agent.cjs', '--cli', cli, '--help'], { encoding: 'utf8', timeout: 5000, env: { ...process.env, ZCODE_COMMUNITY_RETRY_DATA: dir } })
    assert.equal(run.status, 0); assert.equal(run.stdout, 'CLI_OK')
    const status = readStatus(dir)
    assert.equal(status.runtimes.length, 1)
    assert.equal(status.runtimes[0].state, 'loaded')
    assert.equal(status.active, false, 'an exited runtime is not active')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
