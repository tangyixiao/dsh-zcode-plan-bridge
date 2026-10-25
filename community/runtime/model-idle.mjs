import { AsyncLocalStorage } from 'node:async_hooks'

const streams = new AsyncLocalStorage()

/** Suspend the native idle deadline only for a managed logical stream. The
 * transport owns the retry wait; a committed response gets its idle guard back. */
export function installIdleGuard(prototype, isManaged) {
  const original = Object.getOwnPropertyDescriptor(prototype, 'streamTextWithResolved')?.value
  if (typeof original !== 'function') throw new Error('Unsupported native stream idle adapter')
  function wrapped(request, resolved, ...rest) {
    if (!isManaged(resolved)) return original.call(this, request, resolved, ...rest)
    if (!Number.isFinite(this.streamIdleTimeoutMs)) throw new Error('Unsupported native stream idle timeout')
    const context = { idleMs: this.streamIdleTimeoutMs, committed: false, listeners: new Set(), controller: new AbortController() }, scoped = Object.create(this)
    Object.defineProperty(scoped, 'streamIdleTimeoutMs', { value: 0 })
    const scopedRequest = { ...request, abortSignal: request.abortSignal ? AbortSignal.any([request.abortSignal, context.controller.signal]) : context.controller.signal }
    const iterator = original.call(scoped, scopedRequest, resolved, ...rest)
    return {
      [Symbol.asyncIterator]() { return this },
      next(...args) {
        return streams.run(context, async () => {
          if (context.idleMs <= 0) return iterator.next(...args)
          let timer, rejectIdle
          const idle = new Promise((_, reject) => { rejectIdle = reject })
          const arm = () => {
            if (timer) return
            timer = setTimeout(() => {
              const error = Object.assign(new Error(`Model stream stalled after output: no event received for ${context.idleMs}ms`), { code: 'MODEL_STREAM_IDLE_TIMEOUT' })
              rejectIdle(error)
              context.controller.abort(error)
            }, context.idleMs)
          }
          context.listeners.add(arm)
          try {
            if (context.committed) arm()
            return await Promise.race([iterator.next(...args), idle])
          } finally { clearTimeout(timer); context.listeners.delete(arm) }
        })
      },
      return(...args) { context.controller.abort(); return streams.run(context, () => iterator.return(...args)) },
      throw(...args) { context.controller.abort(args[0]); return streams.run(context, () => iterator.throw(...args)) },
    }
  }
  prototype.streamTextWithResolved = wrapped
  return () => { if (prototype.streamTextWithResolved === wrapped) prototype.streamTextWithResolved = original }
}

export function markCommittedResponse(response) {
  const context = streams.getStore()
  // The retry transport returns an SSE response only after its prelude probe.
  // Keep the watchdog at the model-event iterator: SSE comments and raw byte
  // heartbeats must never refresh the deadline after output is committed.
  if (context && !context.committed && response.ok && response.body && /text\/event-stream/i.test(response.headers.get('content-type') || '')) {
    context.committed = true
    for (const listener of context.listeners) listener()
  }
  return response
}
