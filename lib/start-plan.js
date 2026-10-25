/** Native Host-mode account bootstrap for the desktop Start Plan subscription. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readZaiPlanAuth } from './credentials.js'
import { startPlanAccountConfig, startPlanModelIds } from './zcode-runtime.js'

/**
 * Read the real subscription and prepare isolated per-plugin registry state.
 * Credentials remain in memory and are sent only to their original ZCode service.
 * @param {import('./zcode-runtime.js').BuiltinRuntime | undefined} builtin Kernel release.
 * @param {string} dataBaseDir Account data root.
 * @returns {Promise<{env: Record<string, string>, account: any}>} Launch overlay and account snapshot.
 */
export async function prepareStartPlan(builtin, dataBaseDir) {
  if (builtin === undefined) throw new Error('Start Plan requires a compatible bundled provider config')
  const auth = readZaiPlanAuth(dataBaseDir)
  if (auth.activeProvider !== 'zai') throw new Error('Start Plan mode requires the signed-in Z.AI account')
  const response = await fetch('https://zcode.z.ai/api/v1/zcode-plan/billing/current', {
    headers: {
      authorization: `Bearer ${auth.planToken}`,
      'x-api-key': auth.planToken,
      'user-agent': `ZCode/${builtin.version}`,
      'x-zcode-app-version': builtin.version,
    },
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`Start Plan entitlement HTTP ${response.status}`)
  const release = JSON.parse(fs.readFileSync(builtin.activeFilePath, 'utf8'))
  const rules = release.config.providerConfigRules
  const ids = [...rules.providerRules, ...rules.templateRules]
    .flatMap(/** @param {any} rule */ rule => rule.config?.builtinModelIds ?? [])
  const models = startPlanModelIds(await response.json(), ids)
  const stateDir = path.join(os.homedir(), '.dsh', 'dsh-zcode-plan-bridge')
  fs.mkdirSync(stateDir, { recursive: true })
  const personal = path.join(stateDir, 'start-plan-provider.json')
  if (!fs.existsSync(personal)) fs.writeFileSync(personal, JSON.stringify({
    schemaVersion: 1,
    config: {
      providerConfigRules: { providerRules: [] },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      defaultModelSelection: { providerId: 'account:zai-start-plan', modelId: models[0] },
    },
  }, null, 2), { flag: 'wx' })
  return {
    env: {
      ZCODE_APP_SERVER_AUTH_MODE: 'host',
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin.activeFilePath,
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal,
    },
    account: startPlanAccountConfig(builtin, models),
  }
}
