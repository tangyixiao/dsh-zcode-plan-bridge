/** Shared launch configuration for the independently packable community plugin. */
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from '../community/runtime/config.mjs'

/**
 * @typedef {{enabled: boolean, config: any, dataDirectory: string}} CommunityRetryOptions
 */

/** @param {any} raw @returns {CommunityRetryOptions} */
export function resolveCommunityRetry(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('communityRetry must be an object')
  const { enabled = false, dataDirectory = '', ...config } = raw
  if (typeof enabled !== 'boolean' || typeof dataDirectory !== 'string') throw new Error('Invalid communityRetry configuration')
  return { enabled, config: resolveConfig(config),
    dataDirectory: dataDirectory ? path.resolve(dataDirectory) : path.join(os.homedir(), '.dsh', 'dsh-zcode-plan-bridge', 'community-retry'),
  }
}

/** @param {CommunityRetryOptions | undefined} options @param {string} cli @returns {{args:string[], env:Record<string,string>}} */
export function communityLaunch(options, cli) {
  if (!options?.enabled) return { args: [cli], env: {} }
  return {
    args: [fileURLToPath(new URL('../community/bin/agent.cjs', import.meta.url)), '--cli', cli],
    env: {
      ZCODE_COMMUNITY_RETRY_CONFIG_JSON: JSON.stringify(options.config),
      ZCODE_COMMUNITY_RETRY_DATA: options.dataDirectory,
      ZCODE_COMMUNITY_RETRY_OWNER: 'dsh',
      ZCODE_MODEL_RETRY_MAX_RETRIES: '0',
    },
  }
}
