/** Local-only, allowlisted toolkit diagnostics; never starts an agent. */
import fs from 'node:fs'
import { readZaiPlanAuth } from './credentials.js'
import { locateZcodeCli, resolveBuiltinRuntime } from './zcode-runtime.js'
import { fileURLToPath } from 'node:url'

/** @param {any} [options] @returns {any} */
export function localStatus(options = {}) {
  const cli = locateZcodeCli(options.zcodeCliPath)
  let credentials = 'unavailable'
  try { readZaiPlanAuth(options.zcodeDataBaseDir); credentials = 'readable' } catch { /* Availability, not remote authentication. */ }
  let kernelVersion
  try { kernelVersion = resolveBuiltinRuntime(options.zcodeDataBaseDir, cli)?.version } catch { /* A broken local release remains unknown. */ }
  const pkg = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
  return { schemaVersion: 1, package: 'dsh-zcode-plan-bridge', version: pkg.version, node: process.version, platform: process.platform, architecture: process.arch,
    accountMode: options.accountMode === 'start-plan' ? 'start-plan' : 'standalone', cliAvailable: cli !== '' && fs.existsSync(cli), credentials, ...(kernelVersion ? { kernelVersion } : {}), inference: 'not-tested',
    capabilities: { streaming: true, imageInput: true, modelCatalog: 'cli-reported', communityRetry: true, nativeToolPolicy: ['deny', 'allow-all'], hostApproval: false, imageGeneration: false, videoGeneration: false, checkin: false } }
}

/** @param {any} status @returns {any} */
export function shareableStatus(status) {
  const base = { schemaVersion: 1, package: 'dsh-zcode-plan-bridge', version: /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(status.version) ? status.version : 'unknown',
    node: /^v[\d.]+$/u.test(status.node) ? status.node : 'unknown',
    platform: ['win32', 'darwin', 'linux'].includes(status.platform) ? status.platform : 'other',
    architecture: ['x64', 'arm64', 'ia32', 'arm'].includes(status.architecture) ? status.architecture : 'other',
    accountMode: status.accountMode === 'start-plan' ? 'start-plan' : 'standalone', cliAvailable: status.cliAvailable === true,
    credentials: status.credentials === 'readable' ? 'readable' : 'unavailable', inference: 'not-tested' }
  return { ...base, ...(typeof status.kernelVersion === 'string' && /^[\w.+-]{1,60}$/u.test(status.kernelVersion) ? { kernelVersion: status.kernelVersion } : {}) }
}
