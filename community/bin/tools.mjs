#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { dataDirectory, readStatus, saveConfig } from '../runtime/state.mjs'
import { DEFAULTS, VERSION } from '../runtime/config.mjs'
import { fileURLToPath } from 'node:url'

const dir = dataDirectory()
const properties = Object.fromEntries(Object.entries(DEFAULTS).map(([key, value]) => [key,
  Array.isArray(value) ? { type: 'array', items: { type: 'string' } } : { type: typeof value === 'number' ? 'integer' : typeof value }]))
properties.mode = { type: 'string', enum: ['unlimited', 'bounded'], description: 'unlimited: retry without count/time budget until success or cancellation; bounded: honor maxRetries/budgetMs' }
properties.intervalMs.description = 'Fixed retry interval in milliseconds for unlimited mode; 10000 = 10 seconds. Longer Retry-After is respected.'
properties.maxRetries.description = 'Extra attempt count for bounded mode only; large counts are supported.'
const tools = [
  { name: 'retry_status', description: 'Read community retry configuration and live Agent status. Installation alone does not activate retries.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'retry_configure', description: 'Change community retry settings for newly launched Agents. Does not restart or interrupt current tasks.', inputSchema: { type: 'object', properties, additionalProperties: false } },
]
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value })
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of lines) {
  let message
  try { message = JSON.parse(line) } catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); continue }
  if (message.id === undefined) continue
  let response
  try {
    if (message.method === 'initialize') response = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'zcode-community-retry', version: VERSION } }
    else if (message.method === 'ping') response = {}
    else if (message.method === 'tools/list') response = { tools }
    else if (message.method === 'tools/call') {
      if (message.params?.name === 'retry_status') response = result({ ...readStatus(dir),
        currentAgentPid: Number(process.env.ZCODE_COMMUNITY_RETRY_RUNTIME_PID) || null,
        launcher: fileURLToPath(new URL('./launch-desktop.mjs', import.meta.url)),
      })
      else if (message.params?.name === 'retry_configure') response = result({ config: saveConfig(dir, message.params.arguments ?? {}), appliesTo: 'new Agents' })
      else throw new Error('Unknown tool')
    } else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }) + '\n'); continue }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: response }) + '\n')
  } catch (error) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: error.message }] } }) + '\n')
  }
}
