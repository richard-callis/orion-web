import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, apiFetch, readSSE, type SSEEvent } from './api'

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    },
  })
}

async function collect(chunks: string[]): Promise<SSEEvent[]> {
  const out: SSEEvent[] = []
  for await (const evt of readSSE(streamOf(chunks))) out.push(evt)
  return out
}

describe('readSSE', () => {
  it('parses named events with JSON data', async () => {
    const events = await collect(['event: text\ndata: {"content":"hi"}\n\n'])
    expect(events).toEqual([{ event: 'text', data: '{"content":"hi"}', id: undefined }])
  })

  it('handles events split across chunk boundaries', async () => {
    const events = await collect(['event: te', 'xt\ndata: {"a":', '1}\n', '\nevent: done\ndata: {}\n\n'])
    expect(events.map(e => [e.event, e.data])).toEqual([['text', '{"a":1}'], ['done', '{}']])
  })

  it('defaults the event name, joins multi-line data, skips comments, handles CRLF', async () => {
    const events = await collect([': keep-alive\r\n\r\ndata: line1\r\ndata: line2\r\nid: 7\r\n\r\n'])
    expect(events).toEqual([{ event: 'message', data: 'line1\nline2', id: '7' }])
  })

  it('emits a trailing event without a final blank line', async () => {
    const events = await collect(['data: last'])
    expect(events).toEqual([{ event: 'message', data: 'last', id: undefined }])
  })
})

describe('apiFetch', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('returns parsed JSON on success and JSON-encodes object bodies', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(apiFetch('/api/x', { method: 'POST', body: { a: 1 } })).resolves.toEqual({ ok: true })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.body).toBe('{"a":1}')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })

  it('throws ApiError with the server error message on non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), {
      status: 403, headers: { 'content-type': 'application/json' },
    })))
    const err = await apiFetch('/api/x').catch(e => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(403)
    expect(err.message).toBe('nope (403)')
  })
})
