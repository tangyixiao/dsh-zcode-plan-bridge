#!/usr/bin/env node
'use strict'

async function main() {
  const fs = require('node:fs')
  const path = require('node:path')
  const argv = process.argv.slice(2)
  if (argv[0] !== '--cli' || !argv[1]) throw new Error('Usage: agent.cjs --cli <original zcode.cjs> <ZCode arguments>')
  const cli = path.resolve(argv[1])
  if (cli === __filename || !fs.statSync(cli).isFile()) throw new Error('Invalid original ZCode CLI')
  const source = fs.readFileSync(cli, 'utf8')
  for (const marker of ['globalThis.fetch', 'ZCODE_MODEL_RETRY_MAX_RETRIES']) {
    if (!source.includes(marker)) throw new Error(`Unsupported ZCode CLI: missing capability ${marker}`)
  }
  if (typeof globalThis.fetch !== 'function' || typeof AbortSignal.any !== 'function') throw new Error('Node.js 22+ with fetch and AbortSignal.any is required')
  const { resolveConfig, VERSION } = await import('../runtime/config.mjs')
  const { createRetryFetch } = await import('../runtime/retry-fetch.mjs')
  const { dataDirectory, writeRuntime } = await import('../runtime/state.mjs')
  const { markCommittedResponse, installIdleGuard } = await import('../runtime/model-idle.mjs')
  const dataDir = dataDirectory()
  let raw = {}
  if (process.env.ZCODE_COMMUNITY_RETRY_CONFIG_FILE) {
    raw = JSON.parse(fs.readFileSync(process.env.ZCODE_COMMUNITY_RETRY_CONFIG_FILE, 'utf8'))
  }
  if (process.env.ZCODE_COMMUNITY_RETRY_CONFIG_JSON) raw = { ...raw, ...JSON.parse(process.env.ZCODE_COMMUNITY_RETRY_CONFIG_JSON) }
  const config = resolveConfig(raw)
  process.env.ZCODE_MODEL_RETRY_MAX_RETRIES = '0'
  let latest = { version: VERSION, pid: process.pid, owner: process.env.ZCODE_COMMUNITY_RETRY_OWNER || 'standalone', state: 'loaded', at: Date.now() }
  const persist = () => { try { writeRuntime(dataDir, { ...latest, at: Date.now() }) } catch { process.stderr.write('[community-retry] runtime status write failed\n') } }
  const onStatus = state => {
    latest = { ...latest, ...state }
    persist()
    process.stderr.write(`[community-retry] ${JSON.stringify({ version: VERSION, pid: process.pid, ...state })}\n`)
  }
  persist()
  setInterval(persist, 20000).unref()
  const retryFetch = createRetryFetch(globalThis.fetch.bind(globalThis), config, { onStatus })
  globalThis.fetch = (...args) => retryFetch(...args).then(markCommittedResponse)
  process.stderr.write(`[community-retry] loaded ${VERSION}; native model retries=0\n`)
  process.env.ZCODE_COMMUNITY_RETRY_ACTIVE = VERSION
  process.env.ZCODE_COMMUNITY_RETRY_RUNTIME_PID = String(process.pid)
  process.env.ZCODE_COMMUNITY_RETRY_DATA = dataDir
  process.argv = [process.execPath, cli, ...argv.slice(2)]
  if (config.mode === 'unlimited' && argv.slice(2).some(arg => ['app-server', '--prompt', '-p'].includes(arg))) {
    const Module = require('node:module'), compile = Module.prototype._compile
    const marker = /[\w$]+\(this,["']AiSdkModelAdapter["']\)/g
    if ((source.match(marker) || []).length !== 1) throw new Error('Unsupported CLI stream idle adapter')
    const key = Symbol.for('zcode-community-retry.cli-idle-install')
    globalThis[key] = prototype => {
      installIdleGuard(prototype, resolved => { try { return config.allowedOrigins.includes(new URL(resolved.baseURL).origin) } catch { return false } })
      delete globalThis[key]
    }
    Module.prototype._compile = function (content, filename, ...rest) {
      if (path.resolve(filename) === cli) content = content.replace(marker, match => `${match};globalThis[Symbol.for('zcode-community-retry.cli-idle-install')](this.prototype)`)
      return compile.call(this, content, filename, ...rest)
    }
    try { require(cli) } finally { Module.prototype._compile = compile }
  } else require(cli)
}

main().catch(error => {
  // CLI paths and configuration errors are safe; never print provider response bodies.
  process.stderr.write(`[community-retry] bootstrap failed: ${error.message}\n`)
  process.exitCode = 1
})
