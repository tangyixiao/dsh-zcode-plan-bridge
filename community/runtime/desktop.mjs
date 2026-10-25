import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function createDesktopLaunch(options, processes) {
  if (processes.some(p => /^zcode(?:\.exe)?$/i.test(p.name))) throw new Error('ZCode is already running. Finish active tasks and exit it before using this launcher.')
  if (!options.executable || !options.cli || !options.node || !options.dataDir) throw new Error('Desktop executable, CLI, Node and data directory are required')
  const bootstrap = fileURLToPath(new URL('../bin/agent.cjs', import.meta.url))
  return { command: options.executable, args: [], env: {
    ZCODE_AGENT_SERVER_COMMAND: options.node,
    ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify([bootstrap, '--cli', options.cli, 'app-server', '--stdio']),
    ZCODE_COMMUNITY_RETRY_DATA: path.resolve(options.dataDir),
    ZCODE_COMMUNITY_RETRY_CONFIG_FILE: path.join(path.resolve(options.dataDir), 'config.json'),
    ZCODE_COMMUNITY_RETRY_OWNER: 'desktop',
  } }
}
