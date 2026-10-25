#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { createDesktopLaunch } from '../runtime/desktop.mjs'
import { dataDirectory, saveConfig } from '../runtime/state.mjs'

try {
  if (process.platform !== 'win32') throw new Error('This desktop launcher currently supports Windows only')
  const { values } = parseArgs({ options: { exe: { type: 'string' }, cli: { type: 'string' }, 'data-dir': { type: 'string' }, 'dry-run': { type: 'boolean' } } })
  const executable = path.resolve(values.exe ?? 'D:/ZCode/ZCode.exe')
  const cli = path.resolve(values.cli ?? path.join(path.dirname(executable), 'resources/glm/zcode.cjs'))
  for (const file of [executable, cli]) if (!fs.statSync(file).isFile()) throw new Error('Desktop executable or CLI is missing')
  const processes = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '@(Get-Process -Name ZCode -ErrorAction SilentlyContinue | ForEach-Object { @{name=$_.ProcessName;pid=$_.Id} }) | ConvertTo-Json -Compress'], { windowsHide: true, encoding: 'utf8' }).trim() || '[]')
  const dir = values['data-dir'] ? path.resolve(values['data-dir']) : dataDirectory()
  const launch = createDesktopLaunch({ executable, cli, node: process.execPath, dataDir: dir }, Array.isArray(processes) ? processes : [processes])
  if (values['dry-run']) { process.stdout.write(JSON.stringify(launch, null, 2) + '\n') }
  else {
    saveConfig(dir, {})
    const child = spawn(launch.command, launch.args, { env: { ...process.env, ...launch.env }, windowsHide: true, stdio: 'ignore', detached: true })
    child.on('error', () => { process.stderr.write('ZCode could not be launched. Check executable permissions.\n'); process.exitCode = 1 })
    child.unref()
    process.stdout.write('ZCode started with community retry. Use retry_status in the plugin to verify the Agent loaded it.\n')
  }
} catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1 }
