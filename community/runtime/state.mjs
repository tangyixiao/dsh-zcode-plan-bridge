import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveConfig, VERSION } from './config.mjs'

export function dataDirectory(env = process.env) {
  return path.resolve(env.ZCODE_COMMUNITY_RETRY_DATA || env.ZCODE_PLUGIN_DATA || path.join(os.homedir(), '.zcode', 'community-retry'))
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  try { fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, file) }
  finally { fs.rmSync(tmp, { force: true }) }
}

export function loadConfig(dir) {
  const file = path.join(dir, 'config.json')
  return resolveConfig(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {})
}

export function saveConfig(dir, patch) {
  // Validate the patch independently so unknown fields never enter the data directory.
  resolveConfig(patch)
  const config = resolveConfig({ ...loadConfig(dir), ...patch })
  atomicJson(path.join(dir, 'config.json'), config)
  return config
}

export function writeRuntime(dir, state) {
  if (!Number.isSafeInteger(state.pid) || state.pid <= 0) throw new Error('Invalid runtime pid')
  const allowed = ['pid', 'version', 'state', 'at', 'owner', 'requestId', 'attempt', 'maxAttempts', 'mode', 'intervalMs', 'delayMs', 'nextAttempt', 'reason', 'retryAt']
  const safe = Object.fromEntries(allowed.filter(k => state[k] !== undefined).map(k => [k, state[k]]))
  atomicJson(path.join(dir, 'runtimes', `${state.pid}.json`), safe)
}

export function readStatus(dir) {
  const root = path.join(dir, 'runtimes'), runtimes = []
  if (fs.existsSync(root)) for (const file of fs.readdirSync(root)) {
    if (!/^\d+\.json$/.test(file)) continue
    try {
      const state = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
      let alive = false
      if (Number.isSafeInteger(state.pid) && state.pid > 0) { try { process.kill(state.pid, 0); alive = true } catch {} }
      runtimes.push({ ...state, live: alive && Date.now() - state.at < 45000 && state.at <= Date.now() + 5000 })
    } catch {}
  }
  return { plugin: 'zcode-community-retry', version: VERSION, installed: true,
    configured: fs.existsSync(path.join(dir, 'config.json')), active: runtimes.some(r => r.live),
    dataDirectory: dir, config: loadConfig(dir), runtimes,
    note: 'Loaded runtime is not proof of a successful model request. Settings apply to newly launched Agents.' }
}
