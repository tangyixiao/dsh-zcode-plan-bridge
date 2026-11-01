#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { dataDirectory, readStatus } from '../runtime/state.mjs'

// This is a normal plugin Hook, invoked by ZCode before sending a prompt. It
// waits for native activation; the user never runs a separate launcher.
if (process.platform === 'win32' && process.env.ZCODE_PLUGIN_ID?.startsWith('zcode-community-retry@')) {
  try {
    let pid = Number(process.env.ZCODE_COMMUNITY_RETRY_NATIVE_PID)
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      const script = `$current=${process.ppid};for($i=0;$i -lt 5 -and $current -gt 0;$i++){$p=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$current);if($p.Name -eq 'ZCode.exe' -and $p.CommandLine -match 'resources[\\/]glm[\\/]zcode.cjs.*app-server.*--surface desktop'){[string]$p.ProcessId;break};$current=$p.ParentProcessId}`
      pid = Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim())
    }
    if (pid > 0) {
      const dir = dataDirectory(), deadline = Date.now() + 30000
      while (!readStatus(dir).runtimes.some(r => r.pid === pid && r.owner === 'zcode-plugin' && r.live)) {
        if (Date.now() >= deadline) throw new Error('Native retry did not activate. Check /retry-status, or disable this plugin to use normal ZCode retries.')
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
  } catch (error) {
    process.stdout.write(JSON.stringify({ continue: false, stopReason: `Community Retry: ${error.message}` }) + '\n')
  }
}
