import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OrionClient } from './orion-client'

describe('OrionClient', () => {
  const cfg = {
    mccUrl: 'http://orion.local',
    environmentId: 'env-1',
    gatewayToken: 'test-token',
    gatewayUrl: 'http://gateway.local',
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    // Clean up any heartbeat timers
    vi.useRealTimers()
  })

  describe('constructor', () => {
    it('creates client with config', () => {
      const client = new OrionClient(cfg)
      expect(client).toBeDefined()
    })
  })

  describe('register', () => {
    it('sends PUT to correct endpoint', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve('') })
      const client = new OrionClient(cfg)
      await client.register('1.0.0')
      expect(global.fetch).toHaveBeenCalledWith(
        'http://orion.local/api/environments/env-1',
        expect.objectContaining({
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer test-token',
          },
          body: expect.stringContaining('"status":"connected"'),
        }),
      )
    })

    it('throws on non-ok response', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('Server error') })
      const client = new OrionClient(cfg)
      await expect(client.register()).rejects.toThrow('Failed to register with ORION: 500')
    })
  })

  describe('disconnect', () => {
    it('sends PUT with disconnected status', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve('') })
      const client = new OrionClient(cfg)
      await client.disconnect()
      expect(global.fetch).toHaveBeenCalledWith(
        'http://orion.local/api/environments/env-1',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ status: 'disconnected' }),
        }),
      )
    })

    it('does not throw on failure', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('network error'))
      const client = new OrionClient(cfg)
      await expect(client.disconnect()).resolves.toBeUndefined()
    })
  })

  describe('fetchTools', () => {
    it('GETs tools with enabled filter', async () => {
      const mockTools = [{ id: 't1', name: 'ls', enabled: true }] as any
      global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(mockTools) })
      const client = new OrionClient(cfg)
      const result = await client.fetchTools()
      expect(global.fetch).toHaveBeenCalledWith(
        'http://orion.local/api/environments/env-1/tools?enabled=true',
        expect.objectContaining({
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer test-token',
          },
        }),
      )
      expect(result).toEqual(mockTools)
    })

    it('throws on non-ok response', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 })
      const client = new OrionClient(cfg)
      await expect(client.fetchTools()).rejects.toThrow('Failed to fetch tools: 401')
    })
  })

  describe('startHeartbeat / stopHeartbeat', () => {
    it('calls onToolsChanged and fetchTools on interval', async () => {
      vi.useFakeTimers()
      const mockTools = [{ id: 't1' }] as any
      global.fetch = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(''), json: () => Promise.resolve(mockTools) })
      const onToolsChanged = vi.fn()
      const client = new OrionClient(cfg)
      client.startHeartbeat(onToolsChanged, 1000, '1.0')
      expect(onToolsChanged).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1050)
      expect(onToolsChanged).toHaveBeenCalledWith(mockTools)
      client.stopHeartbeat()
    })

    it('does not throw on heartbeat failure', async () => {
      vi.useFakeTimers()
      global.fetch = vi.fn().mockRejectedValue(new Error('network error'))
      const onToolsChanged = vi.fn()
      const client = new OrionClient(cfg)
      client.startHeartbeat(onToolsChanged, 1000)
      await vi.advanceTimersByTimeAsync(1050)
      expect(onToolsChanged).not.toHaveBeenCalled()
      client.stopHeartbeat()
    })
  })

  describe('reportIngresses', () => {
    it('POSTs ingresses to correct endpoint', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve('') })
      const client = new OrionClient(cfg)
      await client.reportIngresses([{ host: 'example.com', path: '/api' }])
      expect(global.fetch).toHaveBeenCalledWith(
        'http://orion.local/api/environments/env-1/ingress/sync',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ ingresses: [{ host: 'example.com', path: '/api' }] }),
        }),
      )
    })

    it('does not throw on failure', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('error') })
      const client = new OrionClient(cfg)
      await expect(client.reportIngresses([])).resolves.toBeUndefined()
    })
  })

  describe('reportSyncStatus', () => {
    it('POSTs sync status to correct endpoint', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve('') })
      const client = new OrionClient(cfg)
      await client.reportSyncStatus([{ name: 'my-app', status: 'Healthy' }])
      expect(global.fetch).toHaveBeenCalledWith(
        'http://orion.local/api/environments/env-1/sync-status',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ applications: [{ name: 'my-app', status: 'Healthy' }] }),
        }),
      )
    })

    it('does not throw on failure', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('error') })
      const client = new OrionClient(cfg)
      await expect(client.reportSyncStatus([])).resolves.toBeUndefined()
    })
  })

  describe('fetchNebula', () => {
    it('GETs active nebula for environment', async () => {
      const mockNebula = [{ id: 'n1', name: 'test' }] as any
      global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(mockNebula) })
      const client = new OrionClient(cfg)
      const result = await client.fetchNebula('env-2')
      expect(global.fetch).toHaveBeenCalledWith(
        'http://orion.local/api/environments/env-2/nebula/active',
        expect.objectContaining({
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer test-token',
          },
        }),
      )
      expect(result).toEqual(mockNebula)
    })

    it('throws on non-ok response', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 })
      const client = new OrionClient(cfg)
      await expect(client.fetchNebula('env-2')).rejects.toThrow('Failed to fetch nebula: 404')
    })
  })

  describe('reportHookExecution', () => {
    it('POSTs hook execution report', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve('') })
      const client = new OrionClient(cfg)
      await client.reportHookExecution('env-1', {
        nebulaId: 'n1',
        triggerEvent: 'on_pod_crash',
        actionType: 'run_shell_command',
        status: 'success',
        durationMs: 1500,
      })
      expect(global.fetch).toHaveBeenCalledWith(
        'http://orion.local/api/environments/env-1/nebula/hook/report',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            nebulaId: 'n1',
            triggerEvent: 'on_pod_crash',
            actionType: 'run_shell_command',
            status: 'success',
            durationMs: 1500,
          }),
        }),
      )
    })

    it('does not throw on failure', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('error') })
      const client = new OrionClient(cfg)
      await expect(client.reportHookExecution('env-1', {
        nebulaId: 'n1', triggerEvent: 'test', actionType: 'cmd', status: 'ok',
      })).resolves.toBeUndefined()
    })
  })

  describe('reportTrace', () => {
    it('POSTs trace to observability endpoint', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve('') })
      const client = new OrionClient(cfg)
      await client.reportTrace({ step: 1, type: 'tool_call', toolName: 'ls', toolArgs: '""', toolResult: 'file1' })
      expect(global.fetch).toHaveBeenCalledWith(
        'http://orion.local/api/observability/trace',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            step: 1, type: 'tool_call', toolName: 'ls', toolArgs: '""', toolResult: 'file1',
          }),
        }),
      )
    })

    it('does not throw on failure', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('error') })
      const client = new OrionClient(cfg)
      await expect(client.reportTrace({ step: 1, type: 'tool_call' })).resolves.toBeUndefined()
    })

    it('includes optional fields when provided', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve('') })
      const client = new OrionClient(cfg)
      await client.reportTrace({
        conversationId: 'conv-1',
        taskId: 'task-1',
        step: 2,
        type: 'completion',
        skillName: 'k8s-debug',
        hookName: 'diagnose_pod_crashloop',
        durationMs: 5000,
        modelUsed: 'claude-3.5-sonnet',
        tokensIn: 1000,
        tokensOut: 200,
        costCents: 0.5,
      })
      const body = JSON.parse((global.fetch as any).mock.calls[0][1].body)
      expect(body.conversationId).toBe('conv-1')
      expect(body.taskId).toBe('task-1')
      expect(body.skillName).toBe('k8s-debug')
      expect(body.modelUsed).toBe('claude-3.5-sonnet')
      expect(body.tokensIn).toBe(1000)
      expect(body.costCents).toBe(0.5)
    })
  })
})
