/** Short-lived inspector access. Never commandeer an existing debugger. */
export async function withOwnedInspector(pid, install, io) {
  const unlock = await io.lock()
  let client, opened = false, verified = false, endpoint, result
  try {
    if (await io.list()) throw new Error('Local inspector port is already in use; existing debugger was left untouched')
    io.open(pid); opened = true
    let list
    for (let i = 0; i < 20; i++) { list = await io.list(); if (list?.length) break; await io.pause(100) }
    if (!list?.length) throw new Error('ZCode Agent does not expose the required native runtime capability')
    endpoint = list[0].webSocketDebuggerUrl
    client = await io.connect(endpoint)
    // If the helper disappears after the command is delivered, the Agent itself
    // closes our inspector. This timer belongs only to a positively matching PID.
    const identity = await client.evaluate(`(()=>{if(process.pid!==${pid})return {pid:process.pid};const k=Symbol.for('zcode-community-retry.inspector-watchdog');clearTimeout(globalThis[k]);globalThis[k]=setTimeout(()=>process.getBuiltinModule('node:inspector').close(),30000);globalThis[k].unref();return {pid:process.pid,argv:process.argv,nodeMajor:Number(process.versions.node.split('.')[0]),fetch:typeof globalThis.fetch}})()`)
    verified = identity?.pid === pid
    if (!verified) throw new Error('Native Agent identity mismatch; no code installed')
    result = await install(client, identity)
    return result
  } finally {
    let cleanupError
    if (opened) {
      // A lost connect/identity response must not skip cleanup. Reconnect only to
      // the exact endpoint opened above, and independently verify its PID first.
      if (!verified && endpoint) {
        try {
          client?.close()
          client = await io.connect(endpoint)
          verified = await client.evaluate('process.pid') === pid
        } catch {}
      }
      if (verified && client) {
        try {
          await client.evaluate("(()=>{const k=Symbol.for('zcode-community-retry.inspector-watchdog');clearTimeout(globalThis[k]);delete globalThis[k];setTimeout(()=>process.getBuiltinModule('node:inspector').close(),30);return true})()")
        } catch {
          cleanupError = new Error('Could not close the temporary Agent inspector; native retry activation was not confirmed')
          try { await client.evaluate(`process.pid===${pid}&&globalThis[Symbol.for('zcode-community-retry.native.v1')]?.uninstall('inspector_cleanup_failed');true`) } catch {}
        }
      }
      client?.close()
      let stillOwned = false
      for (let i = 0; i < 25; i++) {
        const list = await io.list()
        stillOwned = !!list?.some(target => target.webSocketDebuggerUrl === endpoint)
        if (!stillOwned) break
        await io.pause(50)
      }
      if (stillOwned) cleanupError ??= new Error('Temporary Agent inspector remains open; native retry activation was not confirmed')
    } else client?.close()
    unlock()
    if (cleanupError) throw cleanupError
  }
}
