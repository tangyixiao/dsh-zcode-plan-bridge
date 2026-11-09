import { readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// These suites exercise a separately installed official CLI/Desktop kernel.
// Keep their assertions intact and run them explicitly through test:native.
const native = new Set(['community-cli.test.mjs', 'community-native.test.mjs', 'force-keeper-native.test.mjs'])
const directory = new URL('../test/', import.meta.url)
const files = (await readdir(directory)).filter(name => name.endsWith('.test.mjs') && !native.has(name)).sort()
if (!files.length) throw new Error('No offline tests were discovered')
console.log(`Offline test files: ${files.length}; official-kernel suites: npm run test:native`)
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files.map(name => fileURLToPath(new URL(name, directory)))], { stdio: 'inherit' })
child.on('error', error => { console.error(error); process.exitCode = 1 })
child.on('exit', (code, signal) => { process.exitCode = signal ? 1 : (code ?? 1) })
