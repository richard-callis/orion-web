/**
 * Browser-side API helpers.
 *
 * `apiFetch` throws `ApiError` on non-2xx responses (plain `fetch` does not),
 * so callers can rely on try/catch for rollback and error toasts.
 * `swrFetcher` plugs the same behaviour into SWR.
 * `readSSE` parses a `text/event-stream` response body into events.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

type JsonBody = Record<string, unknown> | unknown[]

export interface ApiFetchInit extends Omit<RequestInit, 'body'> {
  /** Plain objects/arrays are JSON-encoded with the right Content-Type. */
  body?: BodyInit | JsonBody | null
}

function isJsonBody(body: ApiFetchInit['body']): body is JsonBody {
  if (body == null) return false
  if (Array.isArray(body)) return true
  return Object.getPrototypeOf(body) === Object.prototype
}

/** fetch() that throws on non-2xx and parses JSON responses. */
export async function apiFetch<T = unknown>(input: string, init: ApiFetchInit = {}): Promise<T> {
  const { body, headers, ...rest } = init
  const json = isJsonBody(body)
  const res = await fetch(input, {
    ...rest,
    headers: json ? { 'Content-Type': 'application/json', ...headers } : headers,
    body: json ? JSON.stringify(body) : (body as BodyInit | null | undefined),
  })

  const text = await res.text()
  let parsed: unknown = text
  if (text && (res.headers.get('content-type') ?? '').includes('json')) {
    try { parsed = JSON.parse(text) } catch { /* keep raw text */ }
  }

  if (!res.ok) {
    const detail =
      parsed && typeof parsed === 'object' && 'error' in parsed && typeof (parsed as { error: unknown }).error === 'string'
        ? (parsed as { error: string }).error
        : res.statusText || 'Request failed'
    throw new ApiError(`${detail} (${res.status})`, res.status, parsed)
  }
  return (text ? parsed : undefined) as T
}

/** SWR fetcher backed by apiFetch. */
export const swrFetcher = <T,>(url: string) => apiFetch<T>(url)

/** Human-readable message for any thrown value. */
export function errorMessage(err: unknown, fallback = 'Something went wrong'): string {
  if (err instanceof Error && err.message) return err.message
  if (typeof err === 'string' && err) return err
  return fallback
}

export interface SSEEvent {
  /** `event:` field; defaults to "message". */
  event: string
  /** Raw `data:` payload (multiple data lines joined with "\n"). */
  data: string
  id?: string
}

/**
 * Parse an SSE response body. Handles chunk boundaries, CRLF line endings,
 * multi-line data and comments. Cancels the reader if iteration stops early.
 */
export async function* readSSE(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SSEEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      if (signal?.aborted) return
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n')
      let sep: number
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        const evt = parseBlock(block)
        if (evt) yield evt
      }
    }
    buffer += decoder.decode()
    const evt = parseBlock(buffer.trim())
    if (evt) yield evt
  } finally {
    reader.cancel().catch(() => {})
  }
}

function parseBlock(block: string): SSEEvent | null {
  if (!block) return null
  let event = 'message'
  let id: string | undefined
  const data: string[] = []
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
    else if (field === 'id') id = value
  }
  if (data.length === 0) return null
  return { event, data: data.join('\n'), id }
}

/** Parse the JSON payload of an SSE event, returning null if it is not JSON. */
export function parseSSEData<T = unknown>(evt: SSEEvent): T | null {
  try { return JSON.parse(evt.data) as T } catch { return null }
}
