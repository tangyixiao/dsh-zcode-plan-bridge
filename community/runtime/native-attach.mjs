import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { withOwnedInspector } from './owned-inspector.mjs'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const endpoint = 'http://127.0.0.1:9229/json/list'
const runtime = fileURLToPath(new URL('./native-runtime.mjs', import.meta.url))

export function isDesktopAgent(identity, expectedPid) {
  const argv = identity?.argv
  return identity?.pid === expectedPid && identity?.nodeMajor >= 22 && identity?.fetch === 'function' &&
    Array.isArray(argv) && /[\\/]ZCode\.exe$/i.test(argv[0] || '') &&
    /[\\/]resources[\\/]glm[\\/]zcode\.cjs$/i.test(argv[1] || '') &&
    argv[2] === 'app-server' && argv.includes('--stdio') &&
    argv.some((s, i) => s === '--surface' && argv[i + 1] === 'desktop') &&
    path.resolve(path.dirname(argv[1]), '../..', 'ZCode.exe').toLowerCase() === path.resolve(argv[0]).toLowerCase()
}

export function resolveCliPackage(cliPath) {
  if (typeof cliPath !== 'string' || !path.isAbsolute(cliPath)) throw new Error('Invalid installed CLI kernel path')
  const cli = fs.realpathSync(cliPath), vendor = path.dirname(cli), root = path.dirname(vendor)
  if (path.basename(cli).toLowerCase() !== 'zcode.cjs' || path.basename(vendor).toLowerCase() !== 'vendor') throw new Error('Invalid installed CLI kernel path')
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  if (pkg.name !== 'zcode-app-cli' || typeof pkg.version !== 'string' || !pkg.version.trim()) throw new Error('Invalid zcode-app-cli package identity')
  const entry = fs.realpathSync(path.join(root, 'bin', 'zcode.js'))
  if (path.dirname(path.dirname(entry)).toLowerCase() !== root.toLowerCase()) throw new Error('CLI package entry escapes its installation')
  return { cliPath: cli, packageVersion: pkg.version }
}

export function isCliAgent(identity, expectedPid, expected) {
  const argv = identity?.argv, same = (left, right) => typeof left === 'string' && typeof right === 'string' && path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
  return identity?.pid === expectedPid && identity?.nodeMajor >= 22 && identity?.fetch === 'function' &&
    /[\\/]node\.exe$/i.test(identity.execPath || '') && Array.isArray(argv) &&
    same(argv[0], identity.execPath) && same(argv[1], expected.cliPath) && same(identity.cliPath, expected.cliPath) &&
    identity.packageName === 'zcode-app-cli' && identity.packageVersion === expected.packageVersion
}

function parentMetadata() {
  const pid = process.ppid
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Get-Process -Id ${pid} | Select-Object Id,ProcessName,Path,@{Name='startedAt';Expression={$_.StartTime.ToUniversalTime().ToString('O')}} | ConvertTo-Json -Compress`],
  { encoding: 'utf8', windowsHide: true, timeout: 5000 })
  const identity = JSON.parse(output)
  if (identity.Id !== pid || typeof identity.startedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(identity.startedAt)) throw new Error('Could not verify the direct parent process instance')
  return identity
}

/** Read only the real direct parent's instance; never accept an arbitrary PID. */
export function directParentStartedAt() {
  return parentMetadata().startedAt
}

function parentLooksNative(identity, cli) {
  return cli
    ? /^node$/i.test(identity.ProcessName) && /[\\/]node\.exe$/i.test(identity.Path)
    : /^ZCode$/i.test(identity.ProcessName) && /[\\/]ZCode\.exe$/i.test(identity.Path)
}

async function acquireLock() {
  const file = path.join(os.tmpdir(), 'zcode-community-retry-inspector.lock'), deadline = Date.now() + 8000
  while (true) {
    try { const fd = fs.openSync(file, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() })); fs.closeSync(fd); return () => fs.rmSync(file, { force: true }) }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        const owner = JSON.parse(fs.readFileSync(file, 'utf8'))
        let live = false
        if (Number.isSafeInteger(owner.pid) && owner.pid > 0) { try { process.kill(owner.pid, 0); live = true } catch {} }
        if (!live && Date.now() - fs.statSync(file).mtimeMs > 1000) { fs.rmSync(file, { force: true }); continue }
      } catch {
        try { if (Date.now() - fs.statSync(file).mtimeMs > 10000) fs.rmSync(file, { force: true }) } catch {}
      }
      if (Date.now() >= deadline) throw new Error('Another native retry plugin is attaching; retry shortly')
      await pause(100)
    }
  }
}

async function targets() {
  try { return await (await fetch(endpoint, { signal: AbortSignal.timeout(400) })).json() } catch { return null }
}

export async function connectInspector(url, Socket = WebSocket) {
  if (!/^ws:\/\/127\.0\.0\.1:9229\/[a-f0-9-]+$/i.test(url)) throw new Error('Unexpected inspector endpoint')
  const socket = new Socket(url), pending = new Map()
  let sequence = 0
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Inspector connection timed out')), 2000)
      socket.onopen = () => { clearTimeout(timer); resolve() }
      socket.onerror = () => { clearTimeout(timer); reject(new Error('Inspector connection failed')) }
    })
  } catch (error) { socket.onopen = null; socket.close(); throw error }
  const rejectPending = () => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Inspector connection closed')) }
    pending.clear()
  }
  socket.onclose = rejectPending
  socket.onerror = () => { rejectPending(); socket.close() }
  socket.onmessage = event => {
    const value = JSON.parse(event.data), promise = pending.get(value.id)
    if (!promise) return
    pending.delete(value.id); clearTimeout(promise.timer)
    if (value.error || value.result?.exceptionDetails) promise.reject(new Error(`Agent rejected native retry operation: ${value.result?.exceptionDetails?.exception?.description?.split('\n')[0] || 'unsupported runtime'}`))
    else promise.resolve(value.result)
  }
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Agent retry operation timed out: ${method}`)) }, method === 'Runtime.queryObjects' ? 20000 : 5000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => (await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }))?.result?.value
  return { call, evaluate, close() { rejectPending(); socket.close() } }
}

/** Only the plugin's direct Desktop Agent parent can be attached. */
export async function attachNativeRetry({ dataDir, pluginId, leaseFile, cliPath }) {
  if (process.platform !== 'win32') return { active: false, reason: 'windows_only' }
  const pid = process.ppid, cli = cliPath === undefined ? undefined : resolveCliPackage(cliPath)
  const parent = parentMetadata()
  if (!pluginId?.startsWith('zcode-community-retry@') || !parentLooksNative(parent, cli)) return { active: false, reason: cli ? 'not_native_cli_parent' : 'not_native_desktop_parent' }
  return withOwnedInspector(pid, async (client, identity) => {
    if (!(cli ? isCliAgent(identity, pid, cli) : isDesktopAgent(identity, pid))) throw new Error('Native Agent identity mismatch; no code installed')
    if (directParentStartedAt() !== parent.startedAt) throw new Error('Native Agent process instance changed; no code installed')
    await client.evaluate('process.env.ZCODE_COMMUNITY_RETRY_NATIVE_PID=String(process.pid);true')
    // All arguments are JSON data, never shell interpolation. CJS mainModule owns require.
    const args = JSON.stringify({ dataDir, pluginId, pluginPid: process.pid, leaseFile, pluginRoot: fileURLToPath(new URL('..', import.meta.url)), startedAt: parent.startedAt })
    const prototype = await client.call('Runtime.evaluate', { expression: 'Function.prototype', objectGroup: 'community-retry' })
    const functions = await client.call('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId, objectGroup: 'community-retry' })
    const installed = await client.call('Runtime.callFunctionOn', {
      objectId: functions.objects.objectId, returnByValue: true,
      functionDeclaration: `function(){const classes=this.filter(f=>{try{return Object.getOwnPropertyDescriptor(f,'name')?.value==='AiSdkModelExecution'&&typeof f.prototype?.resolveProviderTransport==='function'&&typeof f.prototype?.bindModel==='function'&&typeof f.prototype?.createFactory==='function'}catch{return false}});if(classes.length!==1)throw Error('Unsupported or ambiguous model execution transport');const adapters=this.filter(f=>{try{return Object.getOwnPropertyDescriptor(f,'name')?.value==='AiSdkModelAdapter'&&typeof f.prototype?.streamTextWithResolved==='function'&&typeof f.prototype?.generateTextWithResolved==='function'}catch{return false}});if(adapters.length!==1)throw Error('Unsupported native stream idle adapter');const r=process.mainModule.require.bind(process.mainModule),fs=r('node:fs');const s=fs.readFileSync(process.argv[1],'utf8');if(!s.includes('globalThis.fetch')||!s.includes('ZCODE_MODEL_RETRY_MAX_RETRIES'))throw Error('Unsupported Agent transport');const a=${args},runtime=r(${JSON.stringify(runtime)});a.settingsFile=runtime.resolveNativeSettingsFile(this);a.transportPrototypes=classes.map(f=>f.prototype);a.adapterPrototypes=adapters.map(f=>f.prototype);return runtime.installNativeRetry(a)}`,
    })
    const result = installed.result.value
    await client.call('Runtime.releaseObjectGroup', { objectGroup: 'community-retry' })
    return { ...result, pid, verified: true, cliPath: identity.cliPath ?? identity.argv[1], startedAt: parent.startedAt }
  }, { lock: acquireLock, list: targets, open: target => process._debugProcess(target), connect: connectInspector, pause })
}
