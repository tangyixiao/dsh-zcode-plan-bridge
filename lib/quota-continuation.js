import { setTimeout as delay } from 'node:timers/promises'

const TERMINAL_JOBS = new Set(['completed', 'failed', 'error', 'cancelled', 'killed'])

/**
 * Read twice across a poll interval so a background completion that has queued
 * a new native turn cannot be mistaken for an idle session.
 * @param {{read:(id:string,limit:number)=>Promise<any>, ids:string[], sessionId:string, signal?:AbortSignal, stillCurrent:()=>boolean}} input
 * @param {{timeoutMs?:number, intervalMs?:number}} [timing]
 */
export async function waitForQuotaCheckpoint({ read, ids, sessionId, signal, stillCurrent },
  { timeoutMs = 180_000, intervalMs = 1000 } = {}) {
  const until = Date.now() + timeoutMs
  let previous
  try {
    while (Date.now() < until && !signal?.aborted && stillCurrent()) {
      let progress
      const sequences = []
      for (const id of ids) {
        if (signal?.aborted || !stillCurrent() || Date.now() >= until) return undefined
        const snapshot = await read(id, id === sessionId ? 16 : 1)
        const { projection, runtime } = snapshot ?? {}
        if (projection?.sessionId !== id || !Number.isSafeInteger(runtime?.eventSeq)
          || !Array.isArray(projection.backgroundJobs) || !Array.isArray(projection.activeToolCalls)
          || !Array.isArray(projection.pendingPermissions) || !Array.isArray(snapshot.messages)) return undefined
        if (projection.backgroundJobs.some((/** @type {any} */ job) => job?.status === 'lost')) return undefined
        const idle = ['idle', 'error'].includes(projection.status) && !runtime.activeTurnId
          && !projection.currentTurnId && projection.activeToolCalls.length === 0 && projection.pendingPermissions.length === 0
          && projection.backgroundJobs.every((/** @type {any} */ job) => TERMINAL_JOBS.has(job?.status))
        if (!idle) break
        sequences.push(runtime.eventSeq)
        if (id === sessionId) progress = checkpointProgress(snapshot)
      }
      const stamp = sequences.length === ids.length ? sequences.join(':') : undefined
      if (progress && stamp !== undefined && stamp === previous && !signal?.aborted && stillCurrent()) return progress
      previous = stamp
      await delay(intervalMs, undefined, { signal })
    }
  } catch {
    // Older kernels or an interrupted native process cannot attest that tools drained.
  }
  return undefined
}

/** @param {any} snapshot */
function checkpointProgress(snapshot) {
  const short = (/** @type {unknown} */ value, /** @type {number} */ max) => typeof value === 'string' ? value.slice(0, max) : undefined
  const tools = snapshot.messages
    .flatMap((/** @type {any} */ message) => message.info?.role === 'assistant' && Array.isArray(message.parts) ? message.parts : [])
    .filter((/** @type {any} */ part) => part?.type === 'tool' && ['completed', 'error'].includes(part.state?.status))
    .slice(-16)
    .map((/** @type {any} */ part) => ({ tool: short(part.tool, 64), status: part.state.status, title: short(part.state.title, 200) }))
  const jobs = snapshot.projection.backgroundJobs.slice(-8)
    .map((/** @type {any} */ job) => ({ tool: short(job.toolName, 64), status: job.status, description: short(job.description, 160) }))
  const todos = Array.isArray(snapshot.todos) ? snapshot.todos.slice(0, 12)
    .map((/** @type {any} */ todo) => ({ content: short(todo?.content, 200), status: short(todo?.status, 32) })) : []
  return JSON.stringify({ tools, jobs, todos })
}

/** @param {string[]} checkpoints */
export function continuationPrompt(checkpoints) {
  return [
    '【DSH 自动续跑】前一账号额度耗尽。请接着完成原用户任务，使用当前工作区中的实际进度。',
    '下面的原生会话快照是历史记录。工具可能已对工作区或外部系统产生效果，先用只读检查确认进度，再处理剩余步骤。',
    '对执行结果不明的写入、提交、发送等操作先核实。无法确认时停在该步骤说明情况。若任务已完成，直接报告结果。',
    ...checkpoints,
  ].join('\n')
}
