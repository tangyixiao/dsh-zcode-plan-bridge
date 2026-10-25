import { classify } from './policy.mjs'

export async function cancelReader(reader) {
  let timer
  try { await Promise.race([reader.cancel().catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, 1000) })]) }
  finally { clearTimeout(timer) }
}

function replay(response, reader, chunks, ended) {
  let index = 0
  return new Response(new ReadableStream({
    async pull(controller) {
      if (index < chunks.length) { controller.enqueue(chunks[index++]); return }
      if (ended) { controller.close(); return }
      try { const next = await reader.read(); if (next.done) { ended = true; controller.close() } else controller.enqueue(next.value) }
      catch (error) { controller.error(error) }
    },
    cancel: () => cancelReader(reader),
  }), { status: response.status, statusText: response.statusText, headers: response.headers })
}

function eventDecision(frame) {
  const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')
  if (!data) return { kind: 'meta' }
  if (data === '[DONE]') return { kind: 'commit' }
  let payload
  try { payload = JSON.parse(data) } catch { return { kind: 'commit' } }
  if (payload.error || payload.type === 'error') return { kind: 'error', payload }
  if (payload.type === 'ping') return { kind: 'meta' }
  if (payload.type === 'message_start' && Array.isArray(payload.message?.content) && payload.message.content.length === 0) return { kind: 'meta' }
  if (payload.type === 'content_block_start' && payload.content_block?.type === 'text' && payload.content_block.text === '') return { kind: 'meta' }
  if (payload.type === 'content_block_start' && payload.content_block?.type === 'thinking' && payload.content_block.thinking === '') return { kind: 'meta' }
  if (Array.isArray(payload.choices) && payload.choices.length > 0 && payload.choices.every(c => c.finish_reason == null && c.delta && Object.keys(c.delta).every(k => k === 'role'))) return { kind: 'meta' }
  return { kind: 'commit' }
}

export async function inspectResponse(response, config, signal) {
  const isSse = /text\/event-stream/i.test(response.headers.get('content-type') ?? '')
  if (response.redirected || (!isSse && response.ok) || !response.body) return { response, ...classify(response.status, undefined, response.headers) }
  const reader = response.body.getReader(), chunks = [], decoder = new TextDecoder()
  let bytes = 0, text = '', ended = false
  const deadline = Date.now() + config.probeTimeoutMs
  const nextChunk = async () => {
    signal.throwIfAborted()
    let timer, onAbort
    try {
      return await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new DOMException('Response probe timed out', 'TimeoutError')), Math.max(0, deadline - Date.now()))
          onAbort = () => reject(signal.reason)
          signal.addEventListener('abort', onAbort, { once: true })
        }),
      ])
    } finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort) }
  }
  try {
    while (true) {
      const next = await nextChunk()
      if (next.done) { ended = true; text += decoder.decode(); break }
      chunks.push(next.value); bytes += next.value.byteLength
      if (bytes > config.maxProbeBytes) return { response: replay(response, reader, chunks, ended), retry: false, reason: 'probe_limit' }
      text += decoder.decode(next.value, { stream: true })
      if (isSse) {
        let match
        while ((match = /\r?\n\r?\n/.exec(text))) {
          const frame = text.slice(0, match.index); text = text.slice(match.index + match[0].length)
          const decision = eventDecision(frame)
          if (decision.kind === 'commit') return { response: replay(response, reader, chunks, ended), retry: false, reason: 'output_committed' }
          if (decision.kind === 'error') return { response: replay(response, reader, chunks, ended), ...classify(response.status, decision.payload, response.headers) }
        }
      }
    }
    let payload
    if (!isSse) { try { payload = JSON.parse(text) } catch {} }
    return { response: replay(response, reader, chunks, ended), ...classify(response.status, payload, response.headers) }
  } catch (error) { await cancelReader(reader); throw error }
}
