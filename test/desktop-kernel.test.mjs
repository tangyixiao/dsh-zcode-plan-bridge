import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { resolveOptions, ZcodeAppServerAdapter } from '../lib/index.js'
import { isolatedCli } from '../lib/zswitch-profiles.js'

test('official Desktop kernel opens, reads and closes an unsigned-in session', async (t) => {
  let cli
  try {
    cli = isolatedCli(process.env.ZCODE_TEST_CLI)
  } catch (error) {
    if (process.env.ZCODE_TEST_CLI) throw error
    return t.skip('ZCode Desktop kernel unavailable')
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-native-session-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const saved = { ...process.env }
  t.after(() => { process.env = saved })
  process.env = Object.fromEntries(Object.entries(saved).filter(([key]) => !/^ZCODE_/i.test(key)))
  Object.assign(process.env, { HOME: root, USERPROFILE: root, ZCODE_DATA_BASE_DIR: root,
    APPDATA: path.join(root, 'roaming'), LOCALAPPDATA: path.join(root, 'local'), DSH_HOME: path.join(root, 'dsh') })
  const options = resolveOptions({ zcodeCliPath: cli, zcodeCliNode: process.execPath,
    cliCwd: root, zcodeDataBaseDir: root, accountMode: 'start-plan' })
  const adapter = new ZcodeAppServerAdapter({ options: () => options })
  try {
    await adapter.client.ensureStarted()
    const created = await adapter.client.request('session/create',
      { workspace: { workspacePath: root, workspaceKey: 'bridge-native-session' } }, 15000)
    assert.ok(created.session?.sessionId)
    const params = { sessionId: created.session.sessionId }
    assert.ok(await adapter.client.request('session/read', params, 15000))
    await adapter.client.request('session/close', params, 15000)
  } finally {
    const child = adapter.client.child
    const closed = child && child.exitCode === null ? new Promise(resolve => child.once('close', resolve)) : undefined
    adapter.dispose()
    await closed
  }
})
