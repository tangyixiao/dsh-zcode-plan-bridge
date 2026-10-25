import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const bootstrap = fileURLToPath(new URL('../community/bin/agent.cjs', import.meta.url))
const candidates = [process.env.ZCODE_TEST_CLI, 'D:/npm-global/node_modules/zcode-app-cli/vendor/zcode.cjs', 'D:/ZCode/resources/glm/zcode.cjs'].filter(p => p && fs.existsSync(p))

const runs = candidates.flatMap((cli, i) => i === 0 ? [{ cli, mode: 'success' }, { cli, mode: 'exhausted' }, { cli, mode: 'terminal' }] : [{ cli, mode: 'success' }])
for (const {cli, mode} of runs) test(`real CLI ${mode} uses community retry transport: ${cli}`, { timeout: 45000 }, async () => {
  assert.ok(fs.existsSync(bootstrap), 'community bootstrap must exist')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-retry-cli-'))
  let calls = 0
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {}
    if (!req.url.endsWith('/messages')) { res.writeHead(404).end(); return }
    calls++
    if (mode !== 'success' || calls < 3) { res.writeHead(429, { 'content-type': 'application/json' }).end(JSON.stringify({ error: mode === 'terminal' ? { code: '1113', message: 'Insufficient balance' } : { code: '1302', message: 'user concurrency limit exceeded' } })); return }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const events = [
      { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'GLM-5.3-Flash', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'RETRY_FIXTURE_OK' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]
    res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  let child, stderr = '', sequence = 0, sessionId, terminal, pending = new Map(), notifications = []
  try {
    const builtinSource = path.join(path.dirname(cli), 'provider/zcode-builtin.json')
    const fallbackSource = 'D:/npm-global/node_modules/zcode-app-cli/vendor/provider/zcode-builtin.json'
    const release = JSON.parse(fs.readFileSync(fs.existsSync(builtinSource) ? builtinSource : fallbackSource, 'utf8'))
    const rule = release.config.providerConfigRules.providerRules.find(r => r.providerId === 'account:zai-start-plan')
    rule.config.api.baseUrl = origin
    rule.config.builtinModelIds = ['GLM-5.3-Flash']
    const builtin = path.join(dir, 'builtin.json'), personal = path.join(dir, 'personal.json'), setting = path.join(dir, 'setting.json')
    fs.writeFileSync(builtin, JSON.stringify(release))
    fs.writeFileSync(personal, JSON.stringify({ schemaVersion: 1, config: {
      providerConfigRules: { providerRules: [] }, modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      defaultModelSelection: { providerId: 'account:zai-start-plan', modelId: 'GLM-5.3-Flash' },
    } }))
    fs.writeFileSync(setting, JSON.stringify({ features: { memory: false, mcp: false }, plugins: { enabled: false } }))
    child = spawn(process.execPath, [bootstrap, '--cli', cli, 'app-server', '--stdio', '--surface', 'terminal', '--no-color'], {
      cwd: dir, windowsHide: true, env: { ...process.env, HOME: dir, USERPROFILE: dir, ZCODE_DATA_BASE_DIR: dir,
        ZCODE_APP_SERVER_AUTH_MODE: 'host', ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin,
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal, ZCODE_CLI_SETTINGS_FILE: setting,
        ZCODE_COMMUNITY_RETRY_CONFIG_JSON: JSON.stringify({ baseDelayMs: 0, maxDelayMs: 0, allowedOrigins: [origin] }),
      },
    })
    child.stderr.on('data', b => { stderr = (stderr + b).slice(-6000) })
    const write = m => child.stdin.write(JSON.stringify(m) + '\n')
    createInterface({ input: child.stdout }).on('line', line => {
      let m; try { m = JSON.parse(line) } catch { return }
      if (m.id !== undefined && m.method) {
        write({ id: m.id, result: m.method === 'interaction/requestProviderRuntimeHeaders'
          ? { headersApplied: true, requestAuth: { apiKey: 'local-fixture-only', headers: {} } }
          : m.method === 'session/requestRuntimePreferences' ? { nativeSearchEnhancementsEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false, modelContextBudgetStrategy: 'preflight-v1' } : {} })
      } else if (m.id !== undefined) {
        const p = pending.get(m.id); pending.delete(m.id); if (m.error) p?.reject(new Error(JSON.stringify(m.error))); else p?.resolve(m.result)
      } else { notifications.push(m); if (m.params?.type === 'turn.completed' || m.params?.type === 'turn.failed') terminal = m.params }
    })
    const request = (method, params) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); write({ id, method, params }) })
    const deadline = Date.now() + 35000
    while (!notifications.some(m => m.params?.phase === 'ready' || m.params?.phase === 'committing') && Date.now() < deadline && child.exitCode === null) await new Promise(r => setTimeout(r, 100))
    if (child.exitCode !== null) throw new Error(`CLI exited ${child.exitCode}: ${stderr}`)
    await new Promise(r => setTimeout(r, 2500))
    const base = `zcode-builtin:${release.revision}:${createHash('sha256').update(path.resolve(builtin)).digest('hex')}`
    await request('provider/updateAccountConfig', { revision: 'local-fixture', basedOnZCodeBuiltinRevision: base,
      providers: { 'account:zai-start-plan': { access: { type: 'zhipu-account', entitled: true }, builtinModelIds: ['GLM-5.3-Flash'] } },
      states: { 'account:zai-start-plan': { availability: 'available', entitled: true, current: true } },
    })
    const created = await request('session/create', { workspace: { workspacePath: dir, workspaceKey: 'community-retry-fixture' } })
    sessionId = created.session.sessionId
    await request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous', afterSeq: 0, includeSnapshot: true })
    await request('session/setModel', { sessionId, model: { providerId: 'account:zai-start-plan', modelId: 'GLM-5.3-Flash', options: { reasoningLevel: 'low' } } })
    await new Promise(r => setTimeout(r, 1500))
    await request('session/send', { sessionId, content: 'Reply only RETRY_FIXTURE_OK; do not use tools.' })
    while (!terminal && Date.now() < deadline && child.exitCode === null) await new Promise(r => setTimeout(r, 100))
    assert.equal(terminal?.type, mode === 'success' ? 'turn.completed' : 'turn.failed', JSON.stringify(terminal) + '\n' + stderr)
    if (mode === 'success') assert.match(JSON.stringify(terminal), /RETRY_FIXTURE_OK/)
    assert.equal(calls, mode === 'success' ? 3 : mode === 'terminal' ? 1 : 7, 'native or outer retry must not multiply calls')
    assert.match(stderr, /community-retry.*loaded/)
  } finally {
    if (child) { child.stdin.end(); await Promise.race([new Promise(r => child.once('exit', r)), new Promise(r => setTimeout(r, 2000))]); if (child.exitCode === null) child.kill() }
    server.closeAllConnections(); await new Promise(r => server.close(r))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
