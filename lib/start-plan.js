/** Native Host-mode account bootstrap for the desktop Start Plan subscription. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { credentialsPath, readZaiPlanAuth } from './credentials.js'
import { startPlanAccountConfig, startPlanModelIds } from './zcode-runtime.js'

/**
 * Read current Start Plan authorization without changing any local state.
 * @param {import('./zcode-runtime.js').BuiltinRuntime | undefined} builtin Kernel release.
 * @param {string} dataBaseDir Account data root.
 * @param {typeof fetch} [fetchImpl] HTTP transport.
 * @returns {Promise<string[]>} Currently authorized models known by this kernel.
 */
export async function fetchStartPlanModels(builtin, dataBaseDir, fetchImpl = globalThis.fetch) {
  const { models } = await fetchStartPlanStatus(builtin, dataBaseDir, fetchImpl)
  if (!models.length) throw new Error('No active Start Plan model entitlements')
  return models
}

/** Read-only balance request shared by entitlement bootstrap and manual toolkit refresh.
 * @param {import('./zcode-runtime.js').BuiltinRuntime | undefined} builtin
 * @param {string} dataBaseDir
 * @param {typeof fetch} [fetchImpl]
 */
export async function fetchStartPlanStatus(builtin, dataBaseDir, fetchImpl = globalThis.fetch) {
  if (builtin === undefined) throw new Error('Start Plan requires a compatible bundled provider config')
  const auth = readZaiPlanAuth(dataBaseDir)
  // The zcode.z.ai billing endpoint is family-agnostic: a BigModel-family login
  // (activeProvider 'bigmodel', credentials `zcodejwttoken` + `oauth:bigmodel:*`)
  // presents the same plan JWT and receives the same plans/balances response shape
  // (verified 2026-11-07: plan zcode-v3-start-plan-1106-wk → capabilities ['model:glm-5.3-flash']).
  if (auth.activeProvider !== 'zai' && auth.activeProvider !== 'bigmodel') {
    throw new Error('Start Plan mode requires a signed-in Z.AI or BigModel account')
  }
  let deviceMid
  try {
    const telemetry = JSON.parse(fs.readFileSync(path.join(path.dirname(credentialsPath(dataBaseDir)), 'telemetry-state.json'), 'utf8'))
    deviceMid = typeof telemetry.deviceMid === 'string' ? telemetry.deviceMid.trim() : ''
    if (!/^[\x21-\x7e]{1,256}$/.test(deviceMid)) throw new Error('Invalid device header')
  } catch {
    throw new Error('Start Plan device identifier unavailable: open the existing ZCode client to initialize its telemetry-state.json; the bridge does not generate device IDs')
  }
  const url = new URL('https://zcode.z.ai/api/v1/zcode-plan/billing/balance')
  url.searchParams.set('app_version', builtin.version)
  let response, payload
  try {
    response = await fetchImpl(url.toString(), {
      headers: {
        authorization: `Bearer ${auth.planToken}`,
        'x-api-key': auth.planToken,
        'user-agent': `ZCode/${builtin.version}`,
        'x-zcode-app-version': builtin.version,
        'X-Device-Mid': deviceMid,
      },
      credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    payload = await response.json()
  } catch (error) {
    const status = response && !response.ok ? ` (HTTP ${response.status})` : ''
    throw new Error(`Start Plan balance request failed${status}`, { cause: error })
  }
  const release = JSON.parse(fs.readFileSync(builtin.activeFilePath, 'utf8'))
  const rules = release.config.providerConfigRules
  const ids = [...rules.providerRules, ...rules.templateRules]
    .flatMap(/** @param {any} rule */ rule => rule.config?.builtinModelIds ?? [])
  const responseTime = Date.parse(response.headers.get('date') ?? '') / 1000
  return { ...sanitizePlanBalance(payload), models: startPlanModelIds(payload, ids, { responseTime, allowEmpty: true }) }
}

/** Only authoritative display facts; billing identifiers and arbitrary fields stay private.
 * @param {any} payload @param {number} [observedAt]
 */
export function sanitizePlanBalance(payload, observedAt = Date.now()) {
  /** @param {any} value */
  const text = value => typeof value === 'string' && /^[\p{L}\p{N} ._:/-]{1,100}$/u.test(value) ? value : undefined
  /** @param {any} value */
  const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
  return { observedAt, balances: (Array.isArray(payload?.data?.balances) ? payload.data.balances.slice(0, 100) : []).map(/** @param {any} row */ row => ({
    name: text(row?.show_name), unitType: text(row?.unit_type), totalUnits: number(row?.total_units), usedUnits: number(row?.used_units), remainingUnits: number(row?.remaining_units),
    availableUnits: number(row?.available_units), periodStart: number(row?.period_start), periodEnd: number(row?.period_end), expiresAt: number(row?.expires_at),
  })) }
}

/**
 * Prepare the existing isolated per-plugin Host registry, after authorization.
 * @param {import('./zcode-runtime.js').BuiltinRuntime | undefined} builtin Kernel release.
 * @param {string} dataBaseDir Account data root.
 * @returns {Promise<{env: Record<string, string>, account: any}>} Launch overlay and account snapshot.
 */
export async function prepareStartPlan(builtin, dataBaseDir) {
  const models = await fetchStartPlanModels(builtin, dataBaseDir)
  if (builtin === undefined) throw new Error('Start Plan requires a compatible bundled provider config')
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
