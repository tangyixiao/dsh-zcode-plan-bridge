/**
 * Message serialisation helpers shared by the app-server bridge: image
 * materialisation, conversation flattening, and last-user-message extraction.
 *
 * Pure functions, extracted from the one-shot CLI route that was removed on
 * 2026-09-30; consumed by lib/app-server.js.
 *
 * @module lib/messages
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { offloadedImageText } from '@deepseek-ai/dsh-llm'

/**
 * Minimal structural view of the attachment service this module needs.
 *
 * @typedef {object} ImageAttachmentSource
 * @property {(ref: import('@deepseek-ai/dsh-attachment').ImageAttachmentRef) => string | undefined} [imageHostPath] Zero-copy host path when the backend is host-file-backed.
 * @property {(ref: import('@deepseek-ai/dsh-attachment').ImageAttachmentRef) => Promise<import('@deepseek-ai/dsh-attachment').StoredImageAttachment>} readImage Read and verify one normalised image.
 */

/** Structured logger surface (matches Cordis' logger, kept structural for tests). */
/** @typedef {{ info?: (message: string) => void, warn?: (message: string) => void, error?: (message: unknown) => void, debug?: (message: string) => void }} BridgeLogger */

/**
 * One image block as produced by DSH's message assembly.
 *
 * @typedef {object} ImageContentBlock
 * @property {'image'} type Block discriminator.
 * @property {import('@deepseek-ai/dsh-attachment').ImageAttachmentRef} attachment Durable image reference.
 * @property {true} [offloaded] Marks a request-limit placeholder rather than natively-sent bytes.
 */

/**
 * Result of {@link materializeImages}.
 *
 * @typedef {object} MaterializedImages
 * @property {Map<ImageContentBlock, string>} imageText Image block -> placeholder text.
 * @property {string[]} files Image file paths, in placeholder order.
 * @property {string[]} tempFiles Files this call created (deleted after the turn).
 */

/** Temporary image file extensions (the CLI also sniffs the magic bytes; the extension is a fallback). */
const IMAGE_EXTENSIONS = /** @type {const} */ ({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
})

/**
 * Materialise image blocks into local files the agent can read.
 *
 * DSH image blocks hold a durable attachment reference (`block.attachment`) rather
 * than bytes:
 *   - an offloaded block is already text -> {@link offloadedImageText} placeholder, no file;
 *   - a host-file-backed backend -> `imageHostPath` gives an existing path (zero copy);
 *   - otherwise `readImage` reads the bytes -> written to a temporary file.
 *
 * @param {readonly any[] | undefined} messages Request messages.
 * @param {{ attachments?: ImageAttachmentSource | undefined, logger?: BridgeLogger | undefined }} deps Attachment service and logger.
 * @returns {Promise<MaterializedImages>} Placeholders, file list, and created temp files.
 */
export async function materializeImages(messages, { attachments, logger }) {
  /** @type {Map<ImageContentBlock, string>} */
  const imageText = new Map()
  /** @type {string[]} */
  const files = []
  /** @type {string[]} */
  const tempFiles = []
  if (attachments === undefined) return { imageText, files, tempFiles }
  let index = 0
  for (const message of messages ?? []) {
    for (const block of message?.content ?? []) {
      if (block === null || typeof block !== 'object' || block.type !== 'image') continue
      if (block.offloaded === true) {
        imageText.set(block, offloadedImageText(block.attachment))
        continue
      }
      try {
        let file = attachments.imageHostPath?.(block.attachment)
        if (file === undefined) {
          const stored = await attachments.readImage(block.attachment)
          const ext = IMAGE_EXTENSIONS[stored.ref.mediaType] ?? '.png'
          file = path.join(os.tmpdir(), `dsh-zcode-img-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}-${index + 1}${ext}`)
          fs.writeFileSync(file, Buffer.from(stored.data))
          tempFiles.push(file)
        }
        index += 1
        files.push(file)
        imageText.set(block, `[图片 #${index}]`)
      } catch (/** @type {any} */ error) {
        logger?.warn?.(`zcode: failed to read image attachment (${error?.message ?? error})`)
        imageText.set(block, '[图片（读取失败）]')
      }
    }
  }
  return { imageText, files, tempFiles }
}

/**
 * Delete temporary image files (best effort).
 *
 * @param {readonly string[] | undefined} files Paths created by {@link materializeImages}.
 * @returns {void}
 */
export function removeFiles(files) {
  for (const file of files ?? []) {
    try {
      fs.unlinkSync(file)
    } catch {
      /* Cleanup failure is harmless (temp directory). */
    }
  }
}

/**
 * Old sessions hold leaked pseudo-tool-call markup: the model emitted
 * `<antml:invoke name="pwsh">` as reply text and it stayed in history. Replaying
 * it verbatim teaches the model to keep imitating it -- one bridge note cannot
 * out-argue a screenful of bad examples. Compress it into a placeholder so the
 * history is "detoxified".
 */
const LEAKED_CALL_RE =
  /<antml:invoke\b[^>]*>[\s\S]*?<\/antml:invoke>|<antml:parameter\b[^>]*>[\s\S]*?<\/antml:parameter>|<\/?(?:antml:)?(?:invoke|parameter|function_calls)\b[^>]*>/g
const LEAKED_CALL_HINT = '（历史中曾把工具调用写成正文，已省略；工具要用原生机制调用）'
// Module-level so the placeholder is not recompiled per call (the hint has no regex metacharacters).
const LEAKED_CALL_DUP_RE = new RegExp(`${LEAKED_CALL_HINT}(?:\\s*${LEAKED_CALL_HINT})*`, 'g')

// A streamed name needs a following non-word character: EOF may still become
// `<invoke_more>` on the next delta, which is ordinary text.
const LEAKED_CALL_START_RE = /<\/?(?:antml:)?(?:invoke|parameter|function_calls)(?=\W)/
const LEAKED_CALL_PREFIXES = ['invoke', 'parameter', 'function_calls'].flatMap((name) => [
  `<${name}`, `</${name}`, `<antml:${name}`, `</antml:${name}`,
])
const LEAKED_CALL_MAX_PREFIX_LENGTH = Math.max(...LEAKED_CALL_PREFIXES.map((prefix) => prefix.length))

/**
 * Filter one streamed text or reasoning channel. Hold only a possible tag-name
 * suffix (at most 22 characters), then cut the channel once leaked markup is
 * recognized. Call flush on clean completion to resolve the remaining suffix.
 * Incomplete tag names are dropped at EOF; a bare `<` or `</` stays ordinary text.
 *
 * @returns {{ readonly suppressed: boolean, push(raw: string): string, flush(): string }} Per-channel filter.
 */
export function createLeakedCallFilter() {
  let pending = ''
  let suppressed = false
  return {
    get suppressed() { return suppressed },
    push(raw) {
      if (suppressed) return ''
      const text = pending + raw
      pending = ''
      const leak = text.search(LEAKED_CALL_START_RE)
      if (leak !== -1) {
        suppressed = true
        return text.slice(0, leak)
      }
      const start = text.lastIndexOf('<')
      if (start !== -1 && text.length - start <= LEAKED_CALL_MAX_PREFIX_LENGTH) {
        const suffix = text.slice(start)
        if (LEAKED_CALL_PREFIXES.some((prefix) => prefix.startsWith(suffix))) {
          pending = suffix
          return text.slice(0, start)
        }
      }
      return text
    },
    flush() {
      if (pending !== '' && pending !== '<' && pending !== '</') suppressed = true
      const text = suppressed ? '' : pending
      pending = ''
      return text
    },
  }
}

/**
 * Strip leaked pseudo-tool-call markup from text.
 *
 * A leaked block usually leaves stray tags behind (e.g. a trailing `</invoke>`),
 * so adjacent placeholders collapse into one.
 *
 * @param {unknown} text Text to sanitise.
 * @returns {any} Sanitised text, or the input unchanged when it is not a string.
 */
export function sanitizeLeakedCalls(text) {
  if (typeof text !== 'string') return text
  return text
    .replace(LEAKED_CALL_RE, LEAKED_CALL_HINT)
    .replace(LEAKED_CALL_DUP_RE, LEAKED_CALL_HINT)
}

/**
 * Flatten one message's content into readable text.
 *
 * @param {any} content String or content-block array.
 * @param {Map<ImageContentBlock, string> | undefined} imageText Placeholder map from {@link materializeImages}.
 * @returns {string} Flattened text, '' when nothing readable remains.
 */
function flattenContent(content, imageText) {
  if (typeof content === 'string') return sanitizeLeakedCalls(content)
  if (!Array.isArray(content)) return ''
  return content
    .map((/** @type {any} */ block) => {
      if (block === null || typeof block !== 'object') return ''
      if (block.type === 'text') return sanitizeLeakedCalls(block.text ?? '')
      if (block.type === 'image') return imageText?.get(block) ?? '[图片]'
      if (block.type === 'tool-call') return `[调用工具 ${block.name}]`
      if (block.type === 'reasoning') return ''
      return ''
    })
    .filter((/** @type {string} */ text) => text !== '')
    .join('\n')
}

/**
 * Flatten a whole conversation into readable text (used by a new session's first turn).
 *
 * @param {readonly any[] | undefined} messages Request messages.
 * @param {string | undefined} system System prompt text.
 * @param {Map<ImageContentBlock, string> | undefined} imageText Placeholder map.
 * @returns {string} Sectioned plain text.
 */
export function flattenConversation(messages, system, imageText) {
  /** @type {string[]} */
  const parts = []
  if (typeof system === 'string' && system.trim() !== '') parts.push(`# 系统提示\n${system.trim()}`)
  for (const message of messages ?? []) {
    const content = message.content ?? []
    if (message.role === 'system') {
      const text = flattenContent(content, imageText)
      if (text !== '') parts.push(`# 系统提示\n${text}`)
      continue
    }
    if (message.role === 'assistant') {
      const text = flattenContent(content, imageText)
      const calls = content
        .filter((/** @type {any} */ block) => block !== null && typeof block === 'object' && block.type === 'tool-call')
        .map((/** @type {any} */ block) => `[调用工具 ${block.name}(${block.arguments ?? ''})]`)
      const body = [text, ...calls].filter((/** @type {string} */ value) => value !== '').join('\n')
      if (body !== '') parts.push(`# 助手\n${body}`)
      continue
    }
    const toolResults = content.filter(
      (/** @type {any} */ block) => block !== null && typeof block === 'object' && block.type === 'tool-result',
    )
    for (const result of toolResults) {
      parts.push(`# 工具结果\n${flattenContent(result.content, imageText)}`)
    }
    const text = flattenContent(content, imageText)
    if (text !== '') parts.push(`# 用户\n${text}`)
  }
  return parts.join('\n\n')
}

/**
 * Extract the last user message (a resumed session only sends this one).
 *
 * @param {readonly any[] | undefined} messages Request messages.
 * @param {Map<ImageContentBlock, string> | undefined} imageText Placeholder map.
 * @returns {string} Flattened text of the last non-empty user message, '' when none.
 */
export function lastUserText(messages, imageText) {
  const list = messages ?? []
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index]
    if (message?.role === 'user') {
      const text = flattenContent(message.content, imageText)
      if (text !== '') return text
    }
  }
  return ''
}
