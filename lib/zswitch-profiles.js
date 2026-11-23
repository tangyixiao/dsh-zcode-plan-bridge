/** Private DSH profiles authenticated by the installed first-party ZCode CLI. */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomUUID, randomBytes } from 'node:crypto'
import { ZCODE_CLI_CANDIDATES, desktopStandaloneCatalog } from './zcode-runtime.js'
import { ZSwitchClient, accountError, accountId, defaultAccountPath } from './zswitch.js'

/** @param {string} text */
const hash = text => createHash('sha256').update(text).digest('hex')
/** @type {Map<string, string>} */
const checked = new Map()

/** Require the installed Desktop CLI and its own provider catalog. @param {string} [preferred] */
export function isolatedCli(preferred = '') {
  for (const file of new Set([preferred, ...ZCODE_CLI_CANDIDATES])) {
    if (!file || !path.isAbsolute(file) || path.basename(file) !== 'zcode.cjs') continue
    const dir = path.dirname(file)
    if (path.basename(dir).toLowerCase() !== 'glm' || path.basename(path.dirname(dir)).toLowerCase() !== 'resources') continue
    try {
      const stat = fs.statSync(file)
      if (!stat.isFile() || stat.size > 32 * 1024 * 1024) continue
      const stamp = `${stat.size}:${stat.mtimeMs}:${stat.ino}`
      if (checked.get(file) === stamp) return file
      const bundle = JSON.parse(fs.readFileSync(path.join(dir, '.node-bundle-meta.json'), 'utf8'))
      if (bundle.source !== 'apps/zcode-cli/packages/cli/dist/zcode.cjs' || bundle.entry !== 'zcode.cjs') continue
      if (!desktopStandaloneCatalog(file) && !fs.statSync(path.join(dir, 'provider', 'zcode-builtin.json'), {throwIfNoEntry:false})?.isFile()) continue
      const source = fs.readFileSync(file, 'utf8')
      if (!['Usage: zcode login [zai|bigmodel]', 'loginZCodeCli', 'app-server', 'ZCODE_DATA_BASE_DIR', 'ZCODE_CREDENTIALS_FILE',
        'resolveSharedZCodeCredentialsPath', 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE'].every(word => source.includes(word))) continue
      checked.set(file, stamp)
      return file
    } catch { /* Incomplete or unsupported installation. */ }
  }
  throw accountError('account-isolation-unavailable')
}

/** @param {string} file */
function checkPath(file) {
  let current = path.resolve(file)
  for (;;) {
    const stat = fs.lstatSync(current, { throwIfNoEntry: false })
    if (stat && (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)))) throw accountError('account-profile-boundary')
    const parent = path.dirname(current)
    if (parent === current) return
    current = parent
  }
}

// Use the current Windows user and well-known SIDs so localized account names are immaterial.
// Only a directory just created by this call may have its DACL initialized.
const windowsAcl = `
$ErrorActionPreference = 'Stop'
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
$allowed = @($user.Value, 'S-1-5-18', 'S-1-5-32-544')
$paths = ConvertFrom-Json $env:DSH_PROFILE_ACL_PATHS
foreach ($item in $paths) {
  $acl = if ([IO.Directory]::Exists($item)) { [IO.Directory]::GetAccessControl($item) } else { [IO.File]::GetAccessControl($item) }
  if ($env:DSH_PROFILE_INITIALIZE_ACL -eq '1') {
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
    foreach ($sid in @($user.Value, 'S-1-5-18')) {
      $principal = [Security.Principal.SecurityIdentifier]::new($sid)
      $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    }
    [IO.Directory]::SetAccessControl($item,$acl)
    $acl = if ([IO.Directory]::Exists($item)) { [IO.Directory]::GetAccessControl($item) } else { [IO.File]::GetAccessControl($item) }
  }
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $allowed) { throw 'owner' }
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if (-not ($rules | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -eq $user.Value })) { throw 'access' }
  if ($rules | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -notin $allowed }) { throw 'access' }
}
`
/** @param {string[]} paths @param {boolean} [initialize] */
function privateAccess(paths, initialize = false) {
  try {
    if (process.platform === 'win32') {
      const powershell = path.join(process.env.SystemRoot || 'C:/Windows','System32','WindowsPowerShell','v1.0','powershell.exe')
      execFileSync(powershell, ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(windowsAcl,'utf16le').toString('base64')], {
        env:{SystemRoot:process.env.SystemRoot, WINDIR:process.env.SystemRoot, TEMP:process.env.TEMP, TMP:process.env.TMP,
          PSModulePath:path.join(path.dirname(powershell),'Modules'),DSH_PROFILE_ACL_PATHS:JSON.stringify(paths), DSH_PROFILE_INITIALIZE_ACL:initialize ? '1':'0'},
        windowsHide:true, stdio:'ignore',timeout:10000,
      })
    } else {
      for (const file of paths) {
        const stat = fs.lstatSync(file)
        if (stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error('private access required')
      }
    }
  } catch { throw accountError('account-profile-permissions') }
}

/** @param {string} dir */
function privateDirectory(dir) {
  checkPath(dir)
  try { fs.mkdirSync(dir, {mode:0o700}) }
  catch (error) {
    if (/** @type {any} */ (error).code !== 'EEXIST' || !fs.lstatSync(dir).isDirectory()) throw error
    privateAccess([dir])
    return
  }
  privateAccess([dir], true)
}

/** @param {Record<string,string>} env */
function checkSecret(env) {
  const secret = env.ZCODE_CREDENTIAL_SECRET_FILE
  checkPath(secret)
  const stat = fs.lstatSync(secret, {throwIfNoEntry:false})
  if (!stat?.isFile() || stat.size !== 64) throw accountError('account-login-required')
}

/** The CLI can open several paths below its home, including settings and encryption sidecars. @param {string} root */
function checkTree(root) {
  checkPath(root)
  if (!fs.existsSync(root)) return
  const pending = [root]
  while (pending.length) {
    const dir = /** @type {string} */ (pending.pop())
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) pending.push(file)
      else if (!entry.isFile() || fs.lstatSync(file).nlink !== 1) throw accountError('account-profile-boundary')
    }
  }
  if (fs.existsSync(path.join(root, '.env'))) throw accountError('account-profile-boundary')
}

/** Build a complete child environment. The CLI also consults the process home for its user settings.
 * @param {Record<string,string>} assigned @returns {NodeJS.ProcessEnv} */
export function profileEnvironment(assigned) {
  const root = assigned.ZCODE_DATA_BASE_DIR
  checkTree(root)
  checkSecret(assigned)
  privateAccess([root, assigned.ZCODE_CREDENTIAL_SECRET_FILE])
  /** @type {NodeJS.ProcessEnv} */ const env = {}
  const system = /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC|PROGRAMFILES(?:\(X86\))?|PROGRAMW6432|LANG|LC_[A-Z_]+|TZ|DISPLAY|WAYLAND_DISPLAY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|TERM)$/iu
  for (const [key,value] of Object.entries(process.env)) if (system.test(key) && value !== undefined) env[key] = value
  for (const key of ['ZCODE_DATA_BASE_DIR', 'ZCODE_CREDENTIALS_FILE', 'ZCODE_CREDENTIAL_SECRET_FILE', 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE', 'ZCODE_BUILTIN_PROVIDER_CONFIG_FILE']) env[key] = assigned[key]
  return Object.assign(env, { HOME:root, USERPROFILE:root, APPDATA:path.join(root,'AppData','Roaming'), LOCALAPPDATA:path.join(root,'AppData','Local'),
    XDG_CONFIG_HOME:path.join(root,'.config'), XDG_DATA_HOME:path.join(root,'.local','share'), XDG_CACHE_HOME:path.join(root,'.cache'),
    TMPDIR:path.join(root,'tmp'), TEMP:path.join(root,'tmp'), TMP:path.join(root,'tmp') })
}

/** @param {string} cli @param {string} node @param {string} provider @param {Record<string,string>} env @param {AbortSignal} [signal] */
async function browserLogin(cli, node, provider, env, signal) {
  const child = spawn(node, [cli, 'login', provider, '--json'], {
    env: profileEnvironment(env), cwd: env.ZCODE_DATA_BASE_DIR, shell:false, windowsHide:true, stdio:['ignore','pipe','inherit'],
  })
  return await new Promise((resolve, reject) => {
    let output = '', oversized = false, cancelled = false
    const cancel = () => { cancelled = true; child.kill() }
    const cleanup = () => {
      process.off('SIGINT',cancel)
      process.off('SIGTERM',cancel)
      signal?.removeEventListener('abort',cancel)
    }
    process.once('SIGINT',cancel)
    process.once('SIGTERM',cancel)
    signal?.addEventListener('abort',cancel,{once:true})
    if (signal?.aborted) cancel()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      if (!oversized) output += chunk
      if (output.length > 65536 && !oversized) { oversized = true; child.kill() }
    })
    child.once('error', () => { cleanup(); reject(accountError('account-login-failed')) })
    child.once('close', code => {
      cleanup()
      if (cancelled || code !== 0 || oversized) return reject(accountError('account-login-failed'))
      try { resolve(JSON.parse(output)) } catch { reject(accountError('account-login-failed')) }
    })
  })
}

/** @param {any} member @param {any} user */
function matchesIdentity(member, user) {
  if (member.userId) return typeof user?.user_id === 'string' && member.userId === user.user_id
  return typeof user?.email === 'string' && user.email.trim().toLowerCase() === member.email
}

export class ZSwitchProfiles {
  /** @param {{root:string,cli?:(preferred?:string)=>string,run?:Function}} options */
  constructor(options) { this.root = path.resolve(options.root); this.cli = options.cli ?? isolatedCli; this.run = options.run ?? browserLogin }

  /** @param {string} id */
  directory(id) {
    if (!accountId(id)) throw accountError('account-not-found')
    return path.join(this.root, hash(id))
  }

  /** @param {string} root @param {string} cli */
  paths(root, cli) {
    return { ZCODE_DATA_BASE_DIR:root, ZCODE_CREDENTIALS_FILE:path.join(root,'.zcode','v2','credentials.json'),
      ZCODE_CREDENTIAL_SECRET_FILE:path.join(root,'cli-storage.key'),
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE:path.join(root,'.zcode','v2','provider.json'),
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE:desktopStandaloneCatalog(cli) ?? path.join(path.dirname(cli),'provider','zcode-builtin.json') }
  }

  /** Find the last atomically published, numbered receipt directory. @param {string} dir */
  revision(dir) {
    checkPath(dir)
    if (!fs.existsSync(dir)) return 0
    let last = 0
    for (const entry of fs.readdirSync(dir,{withFileTypes:true})) {
      const match = /^login-([1-9][0-9]{0,8})$/u.exec(entry.name)
      if (match) {
        if (!entry.isDirectory()) throw accountError('account-profile-boundary')
        last = Math.max(last,Number(match[1]))
      }
    }
    return last
  }

  /** @param {any} member */
  recorded(member) {
    const accountDir = this.directory(member.id)
    const revision = this.revision(accountDir)
    const marker = path.join(accountDir,`login-${revision}`,'login.json')
    checkPath(marker)
    const stat = fs.lstatSync(marker,{throwIfNoEntry:false})
    if (!revision || !stat?.isFile() || stat.size > 1024) throw accountError('account-login-required')
    const raw = fs.readFileSync(marker,'utf8')
    let receipt
    try { receipt = JSON.parse(raw) } catch { throw accountError('account-login-required') }
    if (receipt?.id !== member.id || !['zai','bigmodel'].includes(receipt.provider) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(receipt.generation) ||
        (member.provider !== 'unknown' && member.provider !== receipt.provider) ||
        ((member.identityHash || '') !== (receipt.identityHash || ''))) throw accountError('account-login-required')
    const root = path.join(accountDir,receipt.generation)
    checkSecret({ZCODE_CREDENTIAL_SECRET_FILE:path.join(root,'cli-storage.key')})
    const file = path.join(root,'.zcode','v2','credentials.json')
    checkPath(file)
    const native = fs.lstatSync(file, {throwIfNoEntry:false})
    if (!native?.isFile() || !native.size) throw accountError('account-login-required')
    return {receipt,root}
  }

  /** @param {any} member */
  status(member) {
    try { this.recorded(member); return 'recorded' }
    catch (error) { return /** @type {any} */ (error).code === 'account-login-required' ? 'required' : 'unavailable' }
  }

  /** Check DSH's receipt and native file metadata, keeping the official credential document opaque.
   * @param {any} member @param {any} base */
  activate(member, base) {
    const {root, receipt} = this.recorded(member)
    const cli = this.cli(base.zcodeCliPath), env = this.paths(root,cli)
    return { ...base, zcodeCliPath:cli, zcodeDataBaseDir:root, managedAccount:{id:member.id, provider:receipt.provider, generation:receipt.generation, env} }
  }

  /** Publishing a nonempty directory is an atomic no-replace operation on Windows and POSIX.
   * The first concurrent login to claim the next revision wins, without a persistent lock.
   * @param {string} accountDir @param {number} previous @param {any} receipt */
  promote(accountDir, previous, receipt) {
    if (previous >= 999999999) throw accountError('storage-full')
    const staged = path.join(accountDir,receipt.generation,'.receipt')
    const target = path.join(accountDir,`login-${previous + 1}`)
    fs.mkdirSync(staged,{mode:0o700})
    fs.writeFileSync(path.join(staged,'login.json'),JSON.stringify(receipt),{flag:'wx',mode:0o600})
    try { fs.renameSync(staged,target) }
    catch (error) { if (fs.existsSync(target)) throw accountError('stale-state'); throw error }
  }

  /** @param {any} base @param {any} member @param {string} provider @param {()=>Promise<void>} [verifyMember] */
  async login(base, member, provider, verifyMember) {
    if (!['zai','bigmodel'].includes(provider) || (member.provider !== 'unknown' && member.provider !== provider)) throw accountError('account-provider-mismatch')
    if (!member.identityHash && base.bindUnverified !== true) throw accountError('account-identity-unavailable')
    const cli = this.cli(base.zcodeCliPath), accountDir = this.directory(member.id)
    const previous = this.revision(accountDir)
    fs.mkdirSync(path.dirname(this.root), {recursive:true,mode:0o700})
    privateDirectory(this.root)
    privateDirectory(accountDir)
    const generation = randomUUID(), root = path.join(accountDir,generation)
    const env = this.paths(root,cli)
    // Each candidate inherits the verified parent DACL/mode and can never be reused.
    fs.mkdirSync(root,{mode:0o700})
    let promoted = false
    try {
      privateAccess([root])
      fs.mkdirSync(path.dirname(env.ZCODE_CREDENTIALS_FILE), {recursive:true,mode:0o700})
      fs.mkdirSync(path.join(root,'tmp'), {mode:0o700})
      fs.writeFileSync(env.ZCODE_CREDENTIAL_SECRET_FILE,randomBytes(48).toString('base64url'),{flag:'wx',mode:0o600})
      if (base.signal?.aborted) throw accountError('account-login-failed')
      const result = await this.run(cli, base.zcodeCliNode || 'node', provider, env, base.signal)
      if (base.signal?.aborted) throw accountError('account-login-failed')
      checkTree(root)
      const stat = fs.lstatSync(env.ZCODE_CREDENTIALS_FILE, {throwIfNoEntry:false})
      if (result?.status !== 'ready' || result.provider !== provider || typeof result.credentialsPath !== 'string'
          || path.resolve(result.credentialsPath) !== env.ZCODE_CREDENTIALS_FILE || !stat?.isFile() || !stat.size) throw accountError('account-login-failed')
      if (result.configPath !== undefined && (typeof result.configPath !== 'string' || !path.isAbsolute(result.configPath)
          || !path.resolve(result.configPath).startsWith(root + path.sep))) throw accountError('account-profile-boundary')
      if (member.identityHash && !matchesIdentity(member, result.user)) throw accountError('account-identity-mismatch')
      const binding = member.identityHash ? 'existing-identity' : 'user-selected'
      await verifyMember?.()
      if (base.signal?.aborted) throw accountError('account-login-failed')
      this.promote(accountDir,previous,{id:member.id,provider,identityHash:member.identityHash,generation})
      promoted = true
      return {id:member.id, provider, binding}
    } finally {
      // The child has exited. Only an unpublished, newly created candidate is disposable.
      if (!promoted) {
        checkTree(root)
        if (path.dirname(fs.realpathSync(root)) !== fs.realpathSync(accountDir)) throw accountError('account-profile-boundary')
        fs.rmSync(root,{recursive:true})
      }
    }
  }
}

/** Authorize the selected existing manager ID using the same private root used for requests.
 * @param {any} options @param {string} id @param {string} provider */
export async function loginProfile(options, id, provider) {
  const client = new ZSwitchClient({path:options.zSwitchPath})
  const member = await client.member(id)
  const profiles = new ZSwitchProfiles({root:path.join(path.dirname(defaultAccountPath()),'official-profiles')})
  return profiles.login(options, member, provider, async () => {
    const current = await client.member(id)
    if (current.provider !== member.provider || current.identityHash !== member.identityHash) throw accountError('account-identity-mismatch')
  })
}
