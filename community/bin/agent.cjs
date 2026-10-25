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
  let raw = {}
  if (process.env.ZCODE_COMMUNITY_RETRY_CONFIG_FILE) {
    raw = JSON.parse(fs.readFileSync(process.env.ZCODE_COMMUNITY_RETRY_CONFIG_FILE, 'utf8'))
  }
  if (process.env.ZCODE_COMMUNITY_RETRY_CONFIG_JSON) raw = { ...raw, ...JSON.parse(process.env.ZCODE_COMMUNITY_RETRY_CONFIG_JSON) }
  const config = resolveConfig(raw)
  process.env.ZCODE_MODEL_RETRY_MAX_RETRIES = '0'
  const onStatus = state => {
    process.stderr.write(`[community-retry] ${JSON.stringify({ version: VERSION, pid: process.pid, ...state })}\n`)
  }
  globalThis.fetch = createRetryFetch(globalThis.fetch.bind(globalThis), config, { onStatus })
  process.stderr.write(`[community-retry] loaded ${VERSION}; native model retries=0\n`)
  process.env.ZCODE_COMMUNITY_RETRY_ACTIVE = VERSION
  process.argv = [process.execPath, cli, ...argv.slice(2)]
  require(cli)
}

main().catch(error => {
  // CLI paths and configuration errors are safe; never print provider response bodies.
  process.stderr.write(`[community-retry] bootstrap failed: ${error.message}\n`)
  process.exitCode = 1
})
