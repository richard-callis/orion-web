import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRequest, dispatcherConfig, isDispatcherConfigured, listRequests } from './dispatcher-requests'

const TOKEN = 'tok-secret-123'
const fetchMock = vi.fn()
const reply = (status: number, body: unknown) => fetchMock.mockResolvedValueOnce({ status, json: async () => body })
const req = { ref: 'bug1', title: 't', problem: 'p', evidence: 'e' }

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('DISPATCHER_REQUESTS_URL', 'https://dispatcher.example.com/')
  vi.stubEnv('DISPATCHER_REQUESTS_TOKEN', TOKEN)
  vi.stubEnv('DISPATCHER_REQUESTS_REPO', 'owner/name')
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('configuration', () => {
  it.each(['DISPATCHER_REQUESTS_URL', 'DISPATCHER_REQUESTS_TOKEN', 'DISPATCHER_REQUESTS_REPO'])('is off without %s and makes no network call', async name => {
    vi.stubEnv(name, '')
    expect(isDispatcherConfigured()).toBe(false)
    expect(await listRequests()).toEqual({ ok: false, reason: 'not_configured' })
    expect(await createRequest(req)).toEqual({ ok: false, reason: 'not_configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('trims the trailing slash from the URL', () => {
    expect(dispatcherConfig()?.url).toBe('https://dispatcher.example.com')
  })
})

describe('createRequest', () => {
  it('posts the repo and request with a bearer token and a timeout', async () => {
    reply(202, { task_id: 't1', branch: 'b1', state: 'queued' })
    expect(await createRequest(req)).toEqual({ ok: true, outcome: 'accepted', request: { task_id: 't1', branch: 'b1', state: 'queued' } })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://dispatcher.example.com/api/v1/requests')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(init.body)).toEqual({ repo: 'owner/name', ...req })
  })

  it('maps 409 to a duplicate carrying the existing task', async () => {
    reply(409, { error: 'open', task_id: 't9', branch: 'b9', pr_url: 'https://git.example.com/pr/1' })
    expect(await createRequest(req)).toEqual({ ok: true, outcome: 'duplicate', request: { task_id: 't9', branch: 'b9', pr_url: 'https://git.example.com/pr/1' } })
  })

  it.each([[429, 'limit'], [503, 'paused'], [400, 'invalid'], [401, 'unauthorized'], [404, 'disabled'], [500, 'error']])('maps %i to %s', async (status, reason) => {
    reply(status, { error: 'x' })
    expect(await createRequest(req)).toMatchObject({ ok: false, reason, status })
  })

  it('never logs the token when the network fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    fetchMock.mockRejectedValueOnce(new Error(`connect failed (Authorization: Bearer ${TOKEN})`))
    expect(await createRequest(req)).toEqual({ ok: false, reason: 'error' })
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[REDACTED]'))
  })

  it('logs the network cause, with the token scrubbed', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cause = Object.assign(new Error(`connect ECONNREFUSED 10.0.0.5:443 ${TOKEN}`), { code: 'ECONNREFUSED' })
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed', { cause }))
    await createRequest(req)
    const line = String(log.mock.calls[0][0])
    expect(line).toContain('TypeError: fetch failed (ECONNREFUSED connect ECONNREFUSED 10.0.0.5:443 [REDACTED])')
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN)
  })

  it('maps 202 without task_id to error', async () => {
    reply(202, { branch: 'b1' })
    expect(await createRequest(req)).toEqual({ ok: false, reason: 'error', status: 202 })
  })

  it('maps a 200 with a non-JSON body to error', async () => {
    fetchMock.mockResolvedValueOnce({ status: 200, json: async () => { throw new SyntaxError('bad json') } })
    expect(await createRequest(req)).toEqual({ ok: false, reason: 'error', status: 200 })
  })

  it('returns the 400 error text, scrubbed of the token and cut to 200 characters', async () => {
    reply(400, { error: `repo not allowed ${TOKEN} ${'x'.repeat(300)}` })
    const r = await createRequest(req)
    expect(r).toMatchObject({ ok: false, reason: 'invalid', status: 400 })
    const detail = (r as { detail?: string }).detail!
    expect(detail.length).toBe(200)
    expect(detail).toContain('repo not allowed [REDACTED]')
  })
})

describe('listRequests', () => {
  it('returns the overview on 200', async () => {
    reply(200, { configured: true, paused: false, requests: [] })
    const r = await listRequests()
    expect(r.ok && r.overview.requests).toEqual([])
    expect(fetchMock.mock.calls[0][1].method).toBe('GET')
  })

  it('keeps only entries with a string ref and task_id', async () => {
    const ok = { ref: 'bug1', task_id: 't1' }
    reply(200, { requests: [null, 'x', { ref: 5, task_id: 't' }, { ref: 'a' }, ok] })
    const r = await listRequests()
    expect(r.ok && r.overview.requests).toEqual([ok])
  })

  it('rejects a 200 without a requests list', async () => {
    reply(200, { nope: true })
    expect(await listRequests()).toEqual({ ok: false, reason: 'error', status: 200 })
  })

  it.each([[401, 'unauthorized'], [404, 'disabled'], [503, 'unavailable'], [500, 'error']])('maps %i to %s', async (status, reason) => {
    reply(status, {})
    expect(await listRequests()).toEqual({ ok: false, reason, status })
  })

  it('survives a timeout', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fetchMock.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
    expect(await listRequests()).toEqual({ ok: false, reason: 'error' })
  })
})
