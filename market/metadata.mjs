import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'

export const PACKAGE_NAME = 'dsh-zcode-plan-bridge'
export const REGISTRY_URL = 'https://registry.npmjs.org/'
export const INDEX_URL = 'https://tangyixiao.github.io/dsh-zcode-plan-bridge/index.json'
const REPOSITORY_URL = 'https://github.com/tangyixiao/dsh-zcode-plan-bridge'

export class UnpublishedVersionError extends Error {}

/** Build only the stable release selected by the repository manifest. */
export function buildMarketIndex(packument, repositoryManifest) {
  if (repositoryManifest?.name !== PACKAGE_NAME) throw new Error('Repository package name does not match the fixed package')
  const version = repositoryManifest.version
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('Repository version must be an exact stable version')
  }
  if (packument?.name !== PACKAGE_NAME) throw new Error('Registry package name does not match the fixed package')
  if (packument.time?.unpublished) throw new Error('Package has been unpublished')
  const manifest = packument.versions?.[version]
  if (!manifest) throw new UnpublishedVersionError(`${PACKAGE_NAME}@${version} is not published in the public registry yet`)
  if (manifest.name !== PACKAGE_NAME) throw new Error('Published manifest name does not match the fixed package')
  if (manifest.version !== version) throw new Error('Published manifest version does not match the repository version')
  if (manifest.private || manifest.deprecated) throw new Error('Published manifest must be public and non-deprecated')
  const patch = manifest.dsh?.bundle?.patch
  if (typeof patch !== 'string' || patch.trim() === '') throw new Error('Published manifest needs a dsh.bundle.patch string')
  const compatibility = manifest.engines?.dsh
  if (typeof compatibility !== 'string' || compatibility.trim() === '') throw new Error('Published manifest needs top-level engines.dsh')
  const timestamp = packument.time?.[version]
  const milliseconds = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN
  if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error('Published version has an invalid publication timestamp')
  const repository = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
  const repositoryUrl = repository?.replace(/^git\+/, '').replace(/\.git$/, '')
  if (repositoryUrl !== REPOSITORY_URL) throw new Error('Published repository does not match the fixed repository')
  const author = typeof manifest.author === 'string' ? manifest.author : manifest.author?.name

  return parseMarketIndex({
    format: 1,
    title: { en: 'Tangyixiao DSH Plugins', zh: 'Tangyixiao DSH 插件' },
    plugins: [{
      name: manifest.name,
      title: 'ZCode Plan Bridge',
      description: manifest.description,
      author,
      homepage: manifest.homepage,
      repository: { url: repositoryUrl },
      metadata: { keywords: manifest.keywords ?? [] },
      versions: [{
        version,
        publishTimestamp: Math.floor(milliseconds / 1000),
        source: { type: 'npm', registry: REGISTRY_URL },
        engines: { dsh: compatibility },
      }],
    }],
  }, INDEX_URL)
}
