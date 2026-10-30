import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

import { marketInstallTarget } from '@deepseek-ai/dsh-plugin-market-index'

import { buildMarketIndex, PACKAGE_NAME, REGISTRY_URL, UnpublishedVersionError } from './metadata.mjs'

/** Fetch public npm metadata, validate, then atomically replace the published index. */
export async function generateIndex({
  manifestPath = fileURLToPath(new URL('../package.json', import.meta.url)),
  outputPath = fileURLToPath(new URL('./dist/index.json', import.meta.url)),
  fetchImpl = globalThis.fetch,
  attempts = Number(process.env.MARKET_FETCH_ATTEMPTS ?? 3),
  retryDelayMs = Number(process.env.MARKET_RETRY_DELAY_MS ?? 5000),
  timeoutMs = Number(process.env.MARKET_FETCH_TIMEOUT_MS ?? 15000),
} = {}) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) throw new Error('MARKET_FETCH_ATTEMPTS must be an integer from 1 to 10')
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 60000) throw new Error('MARKET_RETRY_DELAY_MS must be an integer from 0 to 60000')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('MARKET_FETCH_TIMEOUT_MS must be an integer from 1 to 60000')
  const repositoryManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  let index
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(`${REGISTRY_URL}${PACKAGE_NAME}`, {
        headers: { accept: 'application/json', 'cache-control': 'no-cache' },
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (response.status === 404) {
        throw new UnpublishedVersionError(`${PACKAGE_NAME}@${repositoryManifest.version} is not published in the public registry yet (HTTP 404)`)
      }
      if (!response.ok) throw new Error(`Public registry request failed: HTTP ${response.status}`)
      index = buildMarketIndex(await response.json(), repositoryManifest)
      break
    } catch (error) {
      if (!(error instanceof UnpublishedVersionError) || attempt === attempts) throw error
      console.error(`${error.message}; retrying (${attempt}/${attempts})`)
      await delay(retryDelayMs)
    }
  }
  const plugin = index.plugins[0]
  const installTarget = marketInstallTarget(plugin.name, plugin.versions[0])
  await mkdir(path.dirname(outputPath), { recursive: true })
  const temporaryPath = `${outputPath}.${process.pid}.tmp`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, outputPath)
  } finally {
    await rm(temporaryPath, { force: true })
  }
  return { index, installTarget, outputPath }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { outputPath, installTarget } = await generateIndex()
    console.log(`Wrote ${outputPath}: ${installTarget.spec} from ${installTarget.registry}`)
  } catch (error) {
    console.error(`Author index generation failed: ${error.message}`)
    process.exitCode = 1
  }
}
