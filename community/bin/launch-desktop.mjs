#!/usr/bin/env node
import { createDesktopLaunch } from '../runtime/desktop.mjs'
try { createDesktopLaunch({}, []) }
catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1 }
