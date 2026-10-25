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

const runs = [{cli: 'D:/ZCode/resources/glm/zcode.cjs', mode: 'unlimited'}, {cli: 'D:/ZCode/resources/glm/zcode.cjs', mode: 'late'}]
for (const {cli, mode} of runs) test(`native Desktop Agent ${mode} loads retry through the installed plugin: ${cli}`, { timeout: 80000 }, async () => {
  assert.ok(fs.existsSync(bootstrap), 'community bootstrap must exist')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-retry-cli-'))
  let calls = 0, phase = mode === 'late' ? 'warmup' : 'recover', times = [], busy
  const server = createServer(async (req, res) => {
    for await (const chunk of req) {}
    if (!req.url.endsWith('/messages')) { res.writeHead(404).end(); return }
    const auxiliary = req.headers['x-zcode-query-source'] && req.headers['x-zcode-query-source'] !== 'main_turn'
    if (!auxiliary) { calls++; times.push(Date.now()) }
    if (!auxiliary && phase !== 'warmup' && (phase !== 'recover' || calls < 26)) { res.writeHead(429, { 'content-type': 'application/json' }).end(JSON.stringify({ error: phase === 'terminal' ? { code: '1113', message: 'Insufficient balance' } : { code: '3008', message: 'user concurrency limit exceeded' } })); return }
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
  let child, stderr = '', loaded = false, sequence = 0, sessionId, terminal, pending = new Map(), notifications = []
  try {
    const builtinSource = path.join(path.dirname(cli), 'provider/zcode-builtin.json')
    const fallbackSource = 'D:/npm-global/node_modules/zcode-app-cli/vendor/provider/zcode-builtin.json'
    const release = JSON.parse(fs.readFileSync(fs.existsSync(builtinSource) ? builtinSource : fallbackSource, 'utf8'))
    const rule = release.config.providerConfigRules.providerRules.find(r => r.providerId === 'account:zai-start-plan')
    rule.config.api.baseUrl = origin
    rule.config.builtinModelIds = ['GLM-5.3-Flash']
    const builtin = path.join(dir, 'builtin.json'), personal = path.join(dir, 'personal.json'), setting = path.join(dir, '.zcode', 'cli', 'config.json')
    fs.mkdirSync(path.dirname(setting), {recursive:true})
    const pluginRoot = mode === 'late' ? path.join(dir,'plugin') : path.resolve('community')
    if (mode === 'late') {fs.cpSync(path.resolve('community'),pluginRoot,{recursive:true});fs.writeFileSync(path.join(pluginRoot,'hooks/hooks.json'),JSON.stringify({hooks:{}}));busy=createServer((q,r)=>r.end('[]'));await new Promise((r,j)=>{busy.once('error',j);busy.listen(9229,'127.0.0.1',r)})}
    fs.writeFileSync(builtin, JSON.stringify(release))
    fs.writeFileSync(personal, JSON.stringify({ schemaVersion: 1, config: {
      providerConfigRules: { providerRules: [] }, modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      defaultModelSelection: { providerId: 'account:zai-start-plan', modelId: 'GLM-5.3-Flash' },
    } }))
    const settings = { features: { memory: false, mcp: true }, plugins: { enabled: true, dirs: [pluginRoot], options: { 'zcode-community-retry@inline': { intervalSeconds: 0.01 } } } }
    fs.writeFileSync(setting, JSON.stringify(settings))
    for (const name of ['config.json','setting.json']) {const f=path.join(dir,'.zcode','cli',name);fs.mkdirSync(path.dirname(f),{recursive:true});if(f!==setting)fs.copyFileSync(setting,f)}
    const dataDir = path.join(dir, 'retry-data'); fs.mkdirSync(dataDir); fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ mode: 'unlimited', intervalMs: 0, allowedOrigins: [origin] }))
    child = spawn('D:/ZCode/ZCode.exe', [cli, 'app-server', '--stdio', '--surface', 'desktop', '--no-color'], {
      cwd: dir, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ZCODE_COMMUNITY_RETRY_DATA: dataDir, HOME: dir, USERPROFILE: dir, ZCODE_DATA_BASE_DIR: dir,
        ZCODE_APP_SERVER_AUTH_MODE: 'host', ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin,
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal, ZCODE_CLI_SETTINGS_FILE: setting,
        ZCODE_COMMUNITY_RETRY_CONFIG_JSON: JSON.stringify({ mode: mode === 'unlimited' ? 'unlimited' : 'bounded', intervalMs: 0, baseDelayMs: 0, maxDelayMs: 0, allowedOrigins: [origin] }),
      },
    })
    child.stderr.on('data', b => { const combined = stderr + b; loaded ||= combined.includes('[community-retry] loaded '); stderr = combined.slice(-6000) })
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
    const deadline = Date.now() + 65000
    while (!notifications.some(m => m.params?.phase === 'ready' || m.params?.phase === 'committing') && Date.now() < deadline && child.exitCode === null) await new Promise(r => setTimeout(r, 100))
    if (child.exitCode !== null) throw new Error(`CLI exited ${child.exitCode}: ${stderr}`)
    await new Promise(r => setTimeout(r, 2500))
    await request('plugins/list', {workspace:{workspacePath:dir,workspaceKey:'community-retry-fixture'}})
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
    if (mode === 'late') {
      assert.equal(terminal?.type,'turn.completed','warmup must create a model before retry activation');assert.equal(calls,1);await new Promise(r=>busy.close(r));busy=undefined;
      const runtimeFile=path.join(dataDir,'runtimes',`${child.pid}.json`),until=Date.now()+25000;
      while ((!fs.existsSync(runtimeFile)||JSON.parse(fs.readFileSync(runtimeFile)).state==='disabled')&&Date.now()<until)await new Promise(r=>setTimeout(r,100));
      assert.ok(fs.existsSync(runtimeFile),'first port-busy failure must recover automatically');
      phase='recover';calls=0;times=[];terminal=undefined;await request('session/send',{sessionId,content:'Retry after plugin activation in the existing conversation.'});
      while(!terminal&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));
    }
    console.log('NATIVE_INTEGRATION',fs.readdirSync(dataDir).filter(f=>f.startsWith('integration-')).map(f=>JSON.parse(fs.readFileSync(path.join(dataDir,f),'utf8')))); console.log('NATIVE_RUNTIME', calls, fs.existsSync(path.join(dataDir,'runtimes')) ? fs.readdirSync(path.join(dataDir,'runtimes')).map(f=>JSON.parse(fs.readFileSync(path.join(dataDir,'runtimes',f),'utf8'))) : []);
    assert.equal(terminal?.type, 'turn.completed', JSON.stringify(terminal) + '\n' + stderr)
    assert.match(JSON.stringify(terminal), /RETRY_FIXTURE_OK/)
    assert.equal(calls, 26, 'native or outer retry must not multiply calls')
    const states = fs.existsSync(path.join(dataDir, 'runtimes')) ? fs.readdirSync(path.join(dataDir, 'runtimes')).map(f=>JSON.parse(fs.readFileSync(path.join(dataDir, 'runtimes', f)))) : []; assert.ok(states.some(s=>s.pid===child.pid && s.owner==='zcode-plugin'), 'native Agent must have a plugin-owned retry runtime')
    assert.ok(times[25] - times[0] >= 240, 'the interval selected in ZCode plugin options must affect physical requests')
    await assert.rejects(fetch('http://127.0.0.1:9229/json/list', { signal: AbortSignal.timeout(500) }), 'temporary inspector must be closed after installation')

    // Terminal provider failures must escape the unlimited loop immediately.
    phase = 'terminal'; terminal = undefined
    await new Promise(r => setTimeout(r, 100))
    await request('session/send', { sessionId, content: 'Terminal error fixture; do not use tools.' })
    while (!terminal && Date.now() < deadline) await new Promise(r => setTimeout(r, 20))
    assert.equal(terminal?.type, 'turn.failed'); assert.equal(calls, 27)

    // A real session/stop must abort an in-progress unlimited wait.
    await request('plugins/configure', {workspace:{workspacePath:dir,workspaceKey:'community-retry-fixture'},pluginId:'zcode-community-retry@inline',scope:'user',options:{intervalSeconds:20}})
    assert.equal(JSON.parse(fs.readFileSync(setting)).plugins.options['zcode-community-retry@inline'].intervalSeconds,20)
    phase = 'cancel'; terminal = undefined
    await new Promise(r => setTimeout(r, 100))
    await request('session/send', { sessionId, content: 'Cancellation fixture; do not use tools.' })
    while (calls < 28 && Date.now() < deadline) await new Promise(r => setTimeout(r, 20))
    assert.equal(calls, 28)
    await request('session/stop', { sessionId })
    const runtimeFile = path.join(dataDir, 'runtimes', `${child.pid}.json`)
    const stoppedDeadline = Date.now() + 3000
    while (!['cancelled', 'failed'].includes(JSON.parse(fs.readFileSync(runtimeFile, 'utf8')).state) && Date.now() < stoppedDeadline) await new Promise(r => setTimeout(r, 20))
    assert.equal(JSON.parse(fs.readFileSync(runtimeFile, 'utf8')).state, 'cancelled')
    await new Promise(r => setTimeout(r, 150)); assert.equal(calls, 28, 'cancel must not make another provider request')
    if (mode === 'unlimited') {
      const workspace = { workspacePath: dir, workspaceKey: 'community-retry-fixture' }, pluginId = 'zcode-community-retry@inline'
      await request('plugins/setEnabled', { workspace, pluginId, scope: 'user', enabled: false })
      const disabledUntil = Date.now() + 3000
      while (JSON.parse(fs.readFileSync(runtimeFile)).state !== 'disabled' && Date.now() < disabledUntil) await new Promise(r => setTimeout(r, 50))
      assert.equal(JSON.parse(fs.readFileSync(runtimeFile)).state, 'disabled')
      await request('plugins/configure', { workspace, pluginId, scope: 'user', options: { intervalSeconds: 0.005 } })
      await request('plugins/setEnabled', { workspace, pluginId, scope: 'user', enabled: true })
      const enabledUntil = Date.now() + 25000
      while (JSON.parse(fs.readFileSync(runtimeFile)).state === 'disabled' && Date.now() < enabledUntil) await new Promise(r => setTimeout(r, 100))
      assert.notEqual(JSON.parse(fs.readFileSync(runtimeFile)).state, 'disabled', 're-enabling the plugin must restore protection')
      phase = 'recover'; calls = 0; times = []; terminal = undefined
      await request('session/send', { sessionId, content: 'Retry again after toggling the plugin in the same conversation.' })
      while (!terminal && Date.now() < deadline) await new Promise(r => setTimeout(r, 50))
      assert.equal(terminal?.type, 'turn.completed'); assert.equal(calls, 26)
    }
  } finally {
    if (child) { child.stdin.end(); await Promise.race([new Promise(r => child.once('exit', r)), new Promise(r => setTimeout(r, 2000))]); if (child.exitCode === null) {child.kill(); await new Promise(r=>child.once('exit',r))} }
    if(busy)await new Promise(r=>busy.close(r))
    server.closeAllConnections(); await new Promise(r => server.close(r))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
