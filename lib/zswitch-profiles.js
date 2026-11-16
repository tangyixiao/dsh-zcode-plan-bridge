/** DSH-only native working profiles sourced from the existing Z·SWITCH library. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes, randomUUID, createCipheriv } from 'node:crypto'
import { credentialsPath, decodeCredentialDocument, readCredentials } from './credentials.js'
import { nativeKeyringProviders } from './credential-key.js'
import { ZCODE_CLI_CANDIDATES, resolveBuiltinRuntime } from './zcode-runtime.js'
import { accountError, accountId } from './zswitch.js'

/** Reuse native npm CLI isolation rather than changing Desktop's login. @param {string} [preferred] @returns {string} */
export function isolatedCli(preferred = '') {
  for (const file of [...new Set([preferred, ...ZCODE_CLI_CANDIDATES])]) {
    if (!file || !fs.existsSync(file)) continue
    // npm ships this small contract module beside the bundle; Desktop kernels lacking
    // it must not silently ignore CLI-specific credential/settings overrides.
    const config = path.join(path.dirname(file), 'cli-config.cjs')
    try {
      if (fs.statSync(config).size > 2097152) continue
      const source = fs.readFileSync(config, 'utf8')
      if (source.includes('ZCODE_CLI_SETTINGS_FILE') && source.includes('ZCODE_CLI_CREDENTIALS_FILE')) return file
      // Some releases keep the credential override only in the main bundle.
      if (source.includes('ZCODE_CLI_SETTINGS_FILE') && fs.statSync(file).size <= 33554432 && fs.readFileSync(file, 'utf8').includes('ZCODE_CLI_CREDENTIALS_FILE')) return file
    } catch { /* Unsupported kernel; do not change the normal follow-mode selection. */ }
  }
  throw accountError('account-isolation-unavailable')
}
/** Dedicated key protects writable native caches; source ZCode keys stay untouched. @param {string} root @returns {string} */
function protectedSecret(root) {
  const identity = createHash('sha256').update(path.resolve(root)).digest('hex')
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  const lockFile = path.join(root, 'key.lock')
  assertOwnedPath(lockFile)
  let lock
  try { lock = fs.openSync(lockFile, 'wx', 0o600) } catch { throw accountError('storage-busy') }
  try {
  for (const provider of nativeKeyringProviders()) {
    try {
      const entry = new provider.Entry('DSH ZCode Native Profiles', identity, { linux: { store: 'secret-service' } })
      let secret
      try { secret = entry.getPassword() } catch { continue /* Inaccessible is not absent: never reset an existing key. */ }
      if (secret !== undefined && secret !== null && secret !== '') {
        if (!/^[A-Za-z0-9_-]{43}$/u.test(secret)) throw accountError('account-keyring-unavailable')
        return secret
      }
      if (fs.readdirSync(root).some(name => accountId(name) && fs.statSync(path.join(root, name)).isDirectory())) throw accountError('account-keyring-unavailable')
      secret = randomBytes(32).toString('base64url')
      entry.setPassword(secret)
      if (entry.getPassword() !== secret) throw accountError('account-keyring-unavailable')
      return secret
    } catch { /* Never fall back to a plaintext key file. */ }
  }
  throw accountError('account-keyring-unavailable')
  } finally { fs.closeSync(lock); fs.unlinkSync(lockFile) }
}
/** Reject existing symbolic links/junctions anywhere on a writable destination path. @param {string} file */
function assertOwnedPath(file) {
  let current = path.resolve(file)
  for (;;) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw accountError('account-profile-boundary') }
    catch (error) { if (/** @type {any} */ (error)?.code !== 'ENOENT') throw error }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
}
/** @param {string} file @param {any} value */
function atomic(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`
  try { fs.writeFileSync(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file) }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp) }
}

export class ZSwitchProfiles {
  /** @param {{root:string,secret?:(root:string)=>string,cli?:(preferred:string)=>string,builtin?:Function}} options */
  constructor(options) { this.root = options.root; this.secret = options.secret ?? protectedSecret; this.cli = options.cli ?? isolatedCli; this.builtin = options.builtin ?? resolveBuiltinRuntime }
  /** @param {any} snapshot @param {any} base @returns {any} */
  activate(snapshot, base) {
    assertOwnedPath(this.root)
    // Check protection availability before writing any account material.
    const secret = this.secret(this.root)
    if (!accountId(snapshot.id)) throw accountError('account-not-found')
    const cli = this.cli(base.zcodeCliPath)
    const builtin = this.builtin(snapshot.sourceRoot, cli)
    if (!builtin) throw accountError('account-isolation-unavailable')
    const root = path.join(this.root, snapshot.id)
    const file = credentialsPath(root)
    const key = createHash('sha256').update(secret).digest()
    const marker = path.join(root, 'source.json')
    for (const destination of [file, marker, path.join(root, 'provider.json'), path.join(root, 'setting.json'), path.join(path.dirname(file), 'telemetry-state.json'), path.join(root, 'profile.lock')]) assertOwnedPath(destination)
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const lockFile = path.join(root, 'profile.lock')
    let lock
    try { lock = fs.openSync(lockFile, 'wx', 0o600) } catch { throw accountError('storage-busy') }
    try {
      let current
      try { current = JSON.parse(fs.readFileSync(marker, 'utf8')).revision } catch { /* First use. */ }
      if (current !== snapshot.revision || !fs.existsSync(file)) {
        const decoded = decodeCredentialDocument(snapshot.credentials, snapshot.sourceFile)
        if (!decoded.zcodejwttoken || !['zai', 'bigmodel'].includes(String(decoded['oauth:active_provider']))) throw accountError('account-snapshot-unavailable')
        /** @type {Record<string,string>} */ const encrypted = {}
        const fingerprint = createHash('sha256').update(key).digest('hex').slice(0, 24)
        for (const [name, value] of Object.entries(decoded)) {
          if (typeof value !== 'string') throw accountError('account-snapshot-unavailable')
          const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
          const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
          encrypted[name] = `enc:v2:env:${fingerprint}:${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`
        }
        atomic(file, encrypted); atomic(marker, { revision: snapshot.revision })
      }
      // Native refresh writes are preserved only while the saved key can read them.
      // Corruption or a changed key must not silently become a selected account.
      try {
        if (fs.statSync(file).size > 1048576) throw new Error('size')
        const decoded = readCredentials(root, key)
        if (!decoded.zcodejwttoken || !['zai','bigmodel'].includes(String(decoded['oauth:active_provider'])) || Object.values(decoded).some(value => typeof value !== 'string')) throw new Error('credentials')
      } catch { throw accountError('account-profile-invalid') }
      const personal = path.join(root, 'provider.json'), settings = path.join(root, 'setting.json')
      if (!fs.existsSync(personal)) atomic(personal, { schemaVersion: 1, config: { providerConfigRules: { providerRules: [] }, modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] } } })
      if (!fs.existsSync(settings)) atomic(settings, {})
      let deviceMid = snapshot.deviceMid
      if (!deviceMid) {
        try { deviceMid = JSON.parse(fs.readFileSync(path.join(path.dirname(snapshot.sourceFile), 'telemetry-state.json'), 'utf8')).deviceMid } catch { /* Never invent device identifiers. */ }
      }
      if (typeof deviceMid === 'string' && /^[\x21-\x7e]{1,256}$/u.test(deviceMid)) atomic(path.join(path.dirname(file), 'telemetry-state.json'), { deviceMid })
      return { ...base, zcodeCliPath: cli, zcodeDataBaseDir: root, managedAccount: { id: snapshot.id, key, sourceRoot: snapshot.sourceRoot, personalFile: personal,
        env: { ZCODE_DATA_BASE_DIR: root, ZCODE_CLI_CREDENTIALS_FILE: file, ZCODE_CREDENTIAL_SECRET: secret, ZCODE_CLI_SETTINGS_FILE: settings,
          ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin.activeFilePath, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal } } }
    } finally { fs.closeSync(lock); fs.unlinkSync(lockFile) }
  }
}
