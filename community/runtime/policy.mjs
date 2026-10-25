const terminalCodes = new Set(['1113', '1304', '1308', '1309', '1310', '1311', '1313', '401', '403'])
const transientCodes = new Set(['1120', '1230', '1234', '1302', '1303', '1305', '1312'])
const transientStatus = new Set([408, 429, 500, 502, 503, 504])
const networkCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET'])

export function classify(status, payload, headers = new Headers()) {
  if (status === 401) return { retry: false, reason: 'authentication' }
  if (/^(?:false|0)$/i.test(headers.get('x-should-retry')?.trim() ?? '')) return { retry: false, reason: 'provider_disabled' }
  const error = payload?.error ?? payload
  const message = [typeof error === 'string' ? error : undefined, error?.message, error?.msg, payload?.message, payload?.msg].filter(v => typeof v === 'string').join(' ')
  const codes = [error?.code, payload?.code, ...[...message.matchAll(/\[(\d{4})\]/g)].map(m => m[1])].filter(v => v !== undefined).map(String)
  const types = [error?.type, payload?.type].filter(v => typeof v === 'string')
  if (codes.some(code => terminalCodes.has(code)) || types.some(type => /^(?:authentication_error|invalid_request_error|permission_error|insufficient_quota|authorization_error|not_found_error)$/.test(type)) ||
    /insufficient balance|no resource package|unauthori[sz]ed|authentication|invalid.api.key|forbidden|permission.denied|subscription.expired/i.test(message)) {
    return { retry: false, reason: 'terminal_provider' }
  }
  if (codes.some(code => transientCodes.has(code)) || /\b(?:user|model)\s+concurrency\s+limit\s+exceeded\b/i.test(message)) return { retry: true, reason: 'concurrency_or_transient' }
  // Explicit structured business failures are authoritative, even in HTTP 429.
  if (codes.some(code => /^\d{4}$/.test(code))) return { retry: false, reason: 'unknown_business_code' }
  return { retry: transientStatus.has(status), reason: `http_${status}` }
}

export function retryAfter(headers, now, maxMs = 300000) {
  const ms = headers.get('retry-after-ms')
  const value = headers.get('retry-after')
  let result
  if (ms !== null && /^\d+(?:\.\d+)?$/.test(ms.trim())) result = Number(ms)
  else if (value !== null) result = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - now
  return Number.isFinite(result) && result >= 0 && result <= maxMs ? Math.round(result) : undefined
}

export function isNetworkError(error) {
  return error?.name === 'TimeoutError' || networkCodes.has(error?.code) || networkCodes.has(error?.cause?.code)
}

export function isModelRequest(input, init, config) {
  try {
    const u = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    return method === 'POST' && config.allowedOrigins.includes(u.origin) && !u.username && !u.password &&
      /\/(?:messages|chat\/completions|responses)\/?$/.test(u.pathname)
  } catch { return false }
}
