/**
 * Defense-in-depth gate tests for the four security write tools.
 *
 * Each test asserts:
 *   - Missing __decision_token → returns a structured error WITHOUT calling fetch
 *   - Valid token bound to actionType + target → proceeds (fetch is called)
 *   - Token signed for a different actionType → rejected
 *   - Token signed for a different target → rejected
 *   - Expired token → rejected
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'crypto'
import { securityTools } from './security'

const SECRET = 'test-secret-must-be-at-least-32-chars-long!!'

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function signLocal(
  payload: { auditId: string; actionType: string; target: string },
  ttlMs = 60_000,
): string {
  const full = { ...payload, exp: Date.now() + ttlMs }
  const payloadBytes = Buffer.from(JSON.stringify(full), 'utf8')
  const mac = createHmac('sha256', Buffer.from(SECRET, 'utf8')).update(payloadBytes).digest()
  return `${b64url(payloadBytes)}.${b64url(mac)}`
}

const findTool = (name: string) => {
  const t = securityTools.find(x => x.name === name)
  if (!t) throw new Error(`tool not found: ${name}`)
  return t
}

describe('Security write tools — decision token gate', () => {
  const originalEnv = { ...process.env }
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    // Reset every env var the write tools touch
    delete process.env.CROWDSEC_API
    delete process.env.CROWDSEC_API_KEY
    delete process.env.WAZUH_API
    delete process.env.WAZUH_USERNAME
    delete process.env.WAZUH_PASSWORD
    delete process.env.FIREWALL_API
    delete process.env.FIREWALL_API_KEY

    process.env.ACTION_SERVICE_TOKEN_SECRET = SECRET
    process.env.CROWDSEC_API = 'http://localhost:8080'
    process.env.CROWDSEC_API_KEY = 'k'
    process.env.WAZUH_API = 'http://localhost:55000'
    process.env.WAZUH_USERNAME = 'admin'
    process.env.WAZUH_PASSWORD = 'secret'
    process.env.FIREWALL_API = 'http://localhost:9000'
    process.env.FIREWALL_API_KEY = 'fw'

    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ ok: true })),
    })
    global.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    Object.assign(process.env, originalEnv)
  })

  // ── crowdsec_decision_create ─────────────────────────────────────────────
  describe('crowdsec_decision_create', () => {
    const tool = () => findTool('crowdsec_decision_create')

    it('missing token → rejects without HTTP call', async () => {
      const result = await tool().execute({ ip: '1.2.3.4' })
      expect(result).toContain('__decision_token')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('valid token → proceeds (fetch called)', async () => {
      const token = signLocal({ auditId: 'a', actionType: 'crowdsec_decision_create', target: '1.2.3.4' })
      const result = await tool().execute({ ip: '1.2.3.4', __decision_token: token })
      expect(result).not.toContain('decision token rejected')
      expect(fetchMock).toHaveBeenCalledOnce()
    })

    it('wrong actionType in token → rejects', async () => {
      const token = signLocal({ auditId: 'a', actionType: 'firewall_block', target: '1.2.3.4' })
      const result = await tool().execute({ ip: '1.2.3.4', __decision_token: token })
      expect(result).toContain('decision token rejected')
      expect(result).toContain('actionType mismatch')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('wrong target in token → rejects', async () => {
      const token = signLocal({ auditId: 'a', actionType: 'crowdsec_decision_create', target: '9.9.9.9' })
      const result = await tool().execute({ ip: '1.2.3.4', __decision_token: token })
      expect(result).toContain('decision token rejected')
      expect(result).toContain('target mismatch')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('expired token → rejects', async () => {
      const token = signLocal({ auditId: 'a', actionType: 'crowdsec_decision_create', target: '1.2.3.4' }, -1)
      const result = await tool().execute({ ip: '1.2.3.4', __decision_token: token })
      expect(result).toContain('decision token rejected')
      expect(result).toContain('expired')
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  // ── crowdsec_decision_delete ─────────────────────────────────────────────
  describe('crowdsec_decision_delete', () => {
    const tool = () => findTool('crowdsec_decision_delete')

    it('missing token → rejects without HTTP call', async () => {
      const result = await tool().execute({ ip: '1.2.3.4', decisionId: '1.2.3.4' })
      expect(result).toContain('__decision_token')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('valid token (target binds to decisionId field) → proceeds', async () => {
      const token = signLocal({ auditId: 'a', actionType: 'crowdsec_decision_delete', target: '1.2.3.4' })
      const result = await tool().execute({ ip: '1.2.3.4', decisionId: '1.2.3.4', __decision_token: token })
      expect(result).not.toContain('decision token rejected')
      expect(fetchMock).toHaveBeenCalledOnce()
    })

    it('wrong actionType → rejects', async () => {
      const token = signLocal({ auditId: 'a', actionType: 'crowdsec_decision_create', target: '1.2.3.4' })
      const result = await tool().execute({ ip: '1.2.3.4', decisionId: '1.2.3.4', __decision_token: token })
      expect(result).toContain('actionType mismatch')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('wrong target → rejects', async () => {
      const token = signLocal({ auditId: 'a', actionType: 'crowdsec_decision_delete', target: 'other' })
      const result = await tool().execute({ ip: '1.2.3.4', decisionId: '1.2.3.4', __decision_token: token })
      expect(result).toContain('target mismatch')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('expired token → rejects', async () => {
      const token = signLocal({ auditId: 'a', actionType: 'crowdsec_decision_delete', target: '1.2.3.4' }, -1)
      const result = await tool().execute({ ip: '1.2.3.4', decisionId: '1.2.3.4', __decision_token: token })
      expect(result).toContain('expired')
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  // ── wazuh_active_response ────────────────────────────────────────────────
  describe('wazuh_active_response', () => {
    const tool = () => findTool('wazuh_active_response')

    it('missing token → rejects without HTTP call', async () => {
      const result = await tool().execute({ agent: '001', command: 'firewall-drop' })
      expect(result).toContain('__decision_token')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('valid token → proceeds', async () => {
      const token = signLocal({ auditId: 'a', actionType: 'wazuh_active_response', target: '001' })
      const result = await tool().execute({ agent: '001', command: 'firewall-drop', __decision_token: token })
      expect(result).not.toContain('decision token rejected')
      expect(fetchMock).toHaveBeenCalledOnce()
    })

    it('wrong actionType → rejects', async () => {
      const token = signLocal({ auditId: 'a', actionType: 'firewall_block', target: '001' })
      const result = await tool().execute({ agent: '001', command: 'firewall-drop', __decision_token: token })
      expect(result).toContain('actionType mismatch')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('wrong target → rejects', async () => {
      const token = signLocal({ auditId: 'a', actionType: 'wazuh_active_response', target: '002' })
      const result = await tool().execute({ agent: '001', command: 'firewall-drop', __decision_token: token })
      expect(result).toContain('target mismatch')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('expired token → rejects', async () => {
      const token = signLocal({ auditId: 'a', actionType: 'wazuh_active_response', target: '001' }, -1)
      const result = await tool().execute({ agent: '001', command: 'firewall-drop', __decision_token: token })
      expect(result).toContain('expired')
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  // ── firewall_block ───────────────────────────────────────────────────────
  describe('firewall_block', () => {
    const tool = () => findTool('firewall_block')

    it('missing token → rejects without HTTP call', async () => {
      const result = await tool().execute({ cidr: '10.0.0.0/24' })
      expect(result).toContain('__decision_token')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('valid token → proceeds', async () => {
      const token = signLocal({ auditId: 'a', actionType: 'firewall_block', target: '10.0.0.0/24' })
      const result = await tool().execute({ cidr: '10.0.0.0/24', __decision_token: token })
      expect(result).not.toContain('decision token rejected')
      expect(fetchMock).toHaveBeenCalledOnce()
    })

    it('wrong actionType → rejects', async () => {
      const token = signLocal({ auditId: 'a', actionType: 'wazuh_active_response', target: '10.0.0.0/24' })
      const result = await tool().execute({ cidr: '10.0.0.0/24', __decision_token: token })
      expect(result).toContain('actionType mismatch')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('wrong target → rejects', async () => {
      const token = signLocal({ auditId: 'a', actionType: 'firewall_block', target: '192.168.0.0/24' })
      const result = await tool().execute({ cidr: '10.0.0.0/24', __decision_token: token })
      expect(result).toContain('target mismatch')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('expired token → rejects', async () => {
      const token = signLocal({ auditId: 'a', actionType: 'firewall_block', target: '10.0.0.0/24' }, -1)
      const result = await tool().execute({ cidr: '10.0.0.0/24', __decision_token: token })
      expect(result).toContain('expired')
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})
