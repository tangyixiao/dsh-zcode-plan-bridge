#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { atomicJson, dataDirectory, readStatus, saveConfig } from '../runtime/state.mjs'
import { DEFAULTS, VERSION } from '../runtime/config.mjs'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { attachNativeRetry } from '../runtime/native-attach.mjs'
import { nativeConfig, pluginEnabled } from '../runtime/native-runtime.mjs'

const dir = dataDirectory()
const leaseFile = path.join(dir, `lease-${process.pid}.json`)
if (!fs.existsSync(path.join(dir, 'config.json')) && process.env.ZCODE_COMMUNITY_RETRY_INTERVAL_SECONDS !== undefined) {
  const seconds = Number(process.env.ZCODE_COMMUNITY_RETRY_INTERVAL_SECONDS)
  if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 86400) saveConfig(dir, { intervalMs: Math.round(seconds * 1000) })
}
const settingsFile = path.join(os.homedir(), '.zcode', 'cli', 'config.json')
const candidate = process.platform === 'win32' && process.env.ZCODE_PLUGIN_ID?.startsWith('zcode-community-retry@')
let native = { active: false, reason: 'not_initialized', settingsFile }, attaching = false
const lease = () => atomicJson(leaseFile, { pid: process.pid, parentPid: process.ppid, at: Date.now() })
async function activate() {
  if (attaching) return
  attaching = true
  try {
    lease()
    native = await attachNativeRetry({ dataDir: dir, pluginId: process.env.ZCODE_PLUGIN_ID, leaseFile })
  } catch (error) { native = { ...native, active: false, reason: error.message } }
  finally {
    attaching = false
    try { fs.writeFileSync(path.join(dir, `integration-${process.pid}.json`), JSON.stringify({ ...native, pluginPid: process.pid, parentPid: process.ppid })) } catch {}
  }
}
let heartbeat
const properties = Object.fromEntries(Object.entries(DEFAULTS).map(([key, value]) => [key,
  Array.isArray(value) ? { type: 'array', items: { type: 'string' } } : { type: typeof value === 'number' ? 'integer' : typeof value }]))
properties.mode = { type: 'string', enum: ['unlimited', 'bounded'], description: 'unlimited: retry without count/time budget until success or cancellation; bounded: honor maxRetries/budgetMs' }
properties.intervalMs.description = 'Fixed retry interval in milliseconds for unlimited mode; 10000 = 10 seconds. Longer Retry-After is respected.'
properties.maxRetries.description = 'Extra attempt count for bounded mode only; large counts are supported.'
const tools = [
  { name: 'retry_status', description: 'Read community retry configuration and live Agent status. Installation alone does not activate retries.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'retry_configure', description: 'Change saved retry settings. Native plugin uses unlimited mode; its interval can also be set in ZCode plugin settings. An explicit plugin interval takes precedence.', inputSchema: { type: 'object', properties, additionalProperties: false } },
]
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value })
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of lines) {
  let message
  try { message = JSON.parse(line) } catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); continue }
  if (message.id === undefined) continue
  let response
  try {
    if (message.method === 'initialize') {
      setTimeout(() => void activate(), 0)
      let tick = 0
      heartbeat ??= setInterval(() => {
        try {
          lease()
          if (++tick % 5 === 0 && (native.verified || candidate) && !['not_native_desktop_parent', 'windows_only'].includes(native.reason) && !readStatus(dir).runtimes.some(r => r.pid === process.ppid && r.live) && pluginEnabled(native.settingsFile, process.env.ZCODE_PLUGIN_ID)) void activate()
        } catch {}
      }, 1000).unref()
      response = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'zcode-community-retry', version: VERSION } }
    }
    else if (message.method === 'ping') response = {}
    else if (message.method === 'tools/list') response = { tools }
    else if (message.method === 'tools/call') {
      if (message.params?.name === 'retry_status') {
        const status = readStatus(dir), current = status.runtimes.find(r => r.pid === native.pid)
        let effectiveConfig
        try { if (native.verified) effectiveConfig = nativeConfig(dir, native.settingsFile, process.env.ZCODE_PLUGIN_ID) } catch {}
        response = result({ ...status, ...(effectiveConfig ? { config: effectiveConfig } : {}),
          currentAgentPid: native.pid || Number(process.env.ZCODE_COMMUNITY_RETRY_RUNTIME_PID) || null,
          desktopIntegration: { ...native, supported: native.verified === true, active: current?.live === true, reason: current?.live ? undefined : current?.reason || native.reason, method: 'native-plugin-memory' },
        })
      } else if (message.params?.name === 'retry_configure') {
        const patch = message.params.arguments ?? {}
        if (native.verified && patch.mode && patch.mode !== 'unlimited') throw new Error('Native plugin requires unlimited mode')
        if (native.verified && patch.intervalMs !== undefined && native.settingsFile && fs.existsSync(native.settingsFile)) {
          const settings = JSON.parse(fs.readFileSync(native.settingsFile, 'utf8'))
          if (settings.plugins?.options?.[process.env.ZCODE_PLUGIN_ID]?.intervalSeconds !== undefined) throw new Error('Change the interval in ZCode plugin settings; its explicit value overrides saved intervalMs')
        }
        response = result({ config: saveConfig(dir, patch), appliesTo: native.verified ? 'next retry after the current wait' : 'new CLI/DSH Agents' })
      }
      else throw new Error('Unknown tool')
    } else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }) + '\n'); continue }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: response }) + '\n')
  } catch (error) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: error.message }] } }) + '\n')
  }
}
clearInterval(heartbeat)
fs.rmSync(leaseFile, { force: true })
