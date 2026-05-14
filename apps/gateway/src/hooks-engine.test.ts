import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { HooksEngine, type HookEvent } from './hooks-engine'

function createMockOrionClient() {
  return {
    fetchNebula: vi.fn().mockResolvedValue([]),
    reportHookExecution: vi.fn().mockResolvedValue({ ok: true }),
    reportTrace: vi.fn(),
  }
}

describe('HooksEngine', () => {
  let engine: HooksEngine
  let mockClient: ReturnType<typeof createMockOrionClient>

  beforeEach(() => {
    vi.useFakeTimers()
    mockClient = createMockOrionClient()
    engine = new HooksEngine(mockClient)
  })

  afterAll(() => {
    vi.useRealTimers()
  })

  describe('refresh', () => {
    it('fetches hooks from OrionClient and filters by installed+hook', async () => {
      const hooks = [
        { id: 'h1', name: 'crash-hook', category: 'hook', isInstalled: true, spec: JSON.stringify({ triggerType: 'pod_crashloop' }) },
        { id: 'h2', name: 'unused-hook', category: 'hook', isInstalled: false, spec: JSON.stringify({ triggerType: 'pod_oom' }) },
        { id: 'h3', name: 'skill-def', category: 'skill', isInstalled: true, spec: JSON.stringify({ triggerType: 'pod_oom' }) },
      ]
      mockClient.fetchNebula.mockResolvedValue(hooks)
      await engine.refresh('env1')
      const stored = (engine as any).hooks
      expect(stored).toHaveLength(1)
      expect(stored[0].name).toBe('crash-hook')
    })

    it('stores empty array when no hooks returned', async () => {
      mockClient.fetchNebula.mockResolvedValue([])
      await engine.refresh('env1')
      expect((engine as any).hooks).toEqual([])
    })
  })

  describe('matchesFilter', () => {
    function makeEngine() {
      return new HooksEngine(createMockOrionClient())
    }

    it('returns true when event payload matches all filter keys', () => {
      const e = makeEngine()
      const event: HookEvent = { type: 'pod_crashloop', payload: { namespace: 'default', pod_name: 'my-pod' } }
      expect((e as any).matchesFilter(event, { namespace: 'default' })).toBe(true)
    })

    it('returns false when event payload does not match filter value', () => {
      const e = makeEngine()
      const event: HookEvent = { type: 'pod_crashloop', payload: { namespace: 'kube-system' } }
      expect((e as any).matchesFilter(event, { namespace: 'default' })).toBe(false)
    })

    it('returns true for empty filter (all events match)', () => {
      const e = makeEngine()
      const event: HookEvent = { type: 'pod_crashloop', payload: {} }
      expect((e as any).matchesFilter(event, {})).toBe(true)
    })

    it('handles multiple filter keys requiring all to match', () => {
      const e = makeEngine()
      const event: HookEvent = { type: 'pod_crashloop', payload: { namespace: 'default', threshold: 90 } }
      expect((e as any).matchesFilter(event, { namespace: 'default', threshold: 90 })).toBe(true)
    })

    it('returns false if any filter key does not match', () => {
      const e = makeEngine()
      const event: HookEvent = { type: 'pod_crashloop', payload: { namespace: 'default', threshold: 50 } }
      expect((e as any).matchesFilter(event, { namespace: 'default', threshold: 90 })).toBe(false)
    })
  })

  describe('handleEvent', () => {
    function loadHooks(engine2: HooksEngine, hooks: any[]) {
      mockClient.fetchNebula.mockResolvedValue(hooks)
      return engine2.refresh('env1')
    }

    it('matches hook triggerType to event type', async () => {
      const hooks = [
        { id: 'h1', name: 'crash-hook', category: 'hook', isInstalled: true, spec: JSON.stringify({
          triggerType: 'pod_crashloop', triggerFilter: {},
          actionType: 'send_notification', actionConfig: { message: 'crashed' },
        }) },
        { id: 'h2', name: 'oom-hook', category: 'hook', isInstalled: true, spec: JSON.stringify({
          triggerType: 'pod_oom', triggerFilter: {},
          actionType: 'send_notification', actionConfig: { message: 'oom' },
        }) },
      ]
      await loadHooks(engine, hooks)
      const event: HookEvent = { type: 'pod_crashloop', payload: { pod_name: 'test' } }
      await engine.handleEvent(event)
      const calls = mockClient.reportHookExecution.mock.calls
      expect(calls).toHaveLength(1)
      expect(calls[0][1].triggerEvent).toBe('pod_crashloop')
      expect(calls[0][1].status).toBe('success')
    })

    it('skips hook when triggerFilter does not match', async () => {
      const hooks = [
        { id: 'h1', name: 'filtered', category: 'hook', isInstalled: true, spec: JSON.stringify({
          triggerType: 'pod_crashloop', triggerFilter: { namespace: 'production' },
          actionType: 'send_notification', actionConfig: { message: 'x' },
        }) },
      ]
      await loadHooks(engine, hooks)
      const event: HookEvent = { type: 'pod_crashloop', payload: { namespace: 'staging' } }
      await engine.handleEvent(event)
      expect(mockClient.reportHookExecution).not.toHaveBeenCalled()
    })

    it('replaces placeholders in notification message', async () => {
      const hooks = [
        { id: 'h1', name: 'notify', category: 'hook', isInstalled: true, spec: JSON.stringify({
          triggerType: 'pod_crashloop', triggerFilter: {},
          actionType: 'send_notification', actionConfig: { message: 'Pod {pod_name} in {namespace} crashed' },
        }) },
      ]
      await loadHooks(engine, hooks)
      const event: HookEvent = { type: 'pod_crashloop', payload: { pod_name: 'my-pod', namespace: 'default' } }
      await engine.handleEvent(event)
      const calls = mockClient.reportHookExecution.mock.calls
      expect(calls[0][1].output).toBe('Pod my-pod in default crashed')
    })

    it('handles missing payload placeholders with empty string', async () => {
      const hooks = [
        { id: 'h1', name: 'partial', category: 'hook', isInstalled: true, spec: JSON.stringify({
          triggerType: 'pod_crashloop', triggerFilter: {},
          actionType: 'send_notification', actionConfig: { message: '{pod_name} region: {region}' },
        }) },
      ]
      await loadHooks(engine, hooks)
      const event: HookEvent = { type: 'pod_crashloop', payload: { pod_name: 'test' } }
      await engine.handleEvent(event)
      const calls = mockClient.reportHookExecution.mock.calls
      expect(calls[0][1].output).toBe('test region: ')
    })

    it('reports failed status when shell command fails', async () => {
      const hooks = [
        { id: 'h1', name: 'shell-fail', category: 'hook', isInstalled: true, spec: JSON.stringify({
          triggerType: 'pod_crashloop', triggerFilter: {},
          actionType: 'run_shell_command', actionConfig: { command: 'false' },
        }) },
      ]
      await loadHooks(engine, hooks)
      const event: HookEvent = { type: 'pod_crashloop', payload: {} }
      await engine.handleEvent(event)
      const calls = mockClient.reportHookExecution.mock.calls
      expect(calls[0][1].status).toBe('failed')
    })

    it('reports correct durationMs', async () => {
      const hooks = [
        { id: 'h1', name: 'timed', category: 'hook', isInstalled: true, spec: JSON.stringify({
          triggerType: 'pod_crashloop', triggerFilter: {},
          actionType: 'send_notification', actionConfig: { message: 'x' },
        }) },
      ]
      await loadHooks(engine, hooks)
      const event: HookEvent = { type: 'pod_crashloop', payload: {} }
      await engine.handleEvent(event)
      const calls = mockClient.reportHookExecution.mock.calls
 expect(calls[0][1].durationMs).toBeGreaterThanOrEqual(0)
    })

    it('reports to correct environmentId from payload', async () => {
      const hooks = [
        { id: 'h1', name: 'env', category: 'hook', isInstalled: true, spec: JSON.stringify({
          triggerType: 'pod_crashloop', triggerFilter: {},
          actionType: 'send_notification', actionConfig: { message: 'x' },
        }) },
      ]
      await loadHooks(engine, hooks)
      const event: HookEvent = { type: 'pod_crashloop', payload: { environmentId: 'env-prod' } }
      await engine.handleEvent(event)
      const calls = mockClient.reportHookExecution.mock.calls
      expect(calls[0][0]).toBe('env-prod')
    })

    it('fires multiple matching hooks for one event', async () => {
      const hooks = [
        { id: 'h1', name: 'hook1', category: 'hook', isInstalled: true, spec: JSON.stringify({
          triggerType: 'pod_crashloop', triggerFilter: {},
          actionType: 'send_notification', actionConfig: { message: 'a' },
        }) },
        { id: 'h2', name: 'hook2', category: 'hook', isInstalled: true, spec: JSON.stringify({
          triggerType: 'pod_crashloop', triggerFilter: {},
          actionType: 'send_notification', actionConfig: { message: 'b' },
        }) },
        { id: 'h3', name: 'oom-hook', category: 'hook', isInstalled: true, spec: JSON.stringify({
          triggerType: 'pod_oom', triggerFilter: {},
          actionType: 'send_notification', actionConfig: { message: 'c' },
        }) },
      ]
      await loadHooks(engine, hooks)
      const event: HookEvent = { type: 'pod_crashloop', payload: {} }
      await engine.handleEvent(event)
      const calls = mockClient.reportHookExecution.mock.calls
      expect(calls).toHaveLength(2)
      expect(calls[0][1].nebulaId).toBe('h1')
      expect(calls[1][1].nebulaId).toBe('h2')
    })

    it('does not fire if no hooks are loaded', async () => {
      mockClient.fetchNebula.mockResolvedValue([])
      await engine.refresh('env1')
      const event: HookEvent = { type: 'pod_crashloop', payload: {} }
      await engine.handleEvent(event)
      expect(mockClient.reportHookExecution).not.toHaveBeenCalled()
    })
  })

  describe('start/stop', () => {
    it('starts polling interval on start()', () => {
      const spy = vi.spyOn(global, 'setInterval')
      engine.start('env1')
      expect(spy).toHaveBeenCalled()
      spy.mockRestore()
    })

    it('clears interval on stop()', () => {
      const spy = vi.spyOn(global, 'clearInterval')
      engine.start('env1')
      vi.advanceTimersByTime(30000)
      engine.stop()
      expect(spy).toHaveBeenCalled()
      spy.mockRestore()
    })

    it('polls refresh every 30 seconds', async () => {
      mockClient.fetchNebula.mockResolvedValue([])
      const refreshSpy = vi.spyOn(engine, 'refresh')
      engine.start('env1')
      vi.advanceTimersByTime(30000)
      expect(refreshSpy).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(30000)
      expect(refreshSpy).toHaveBeenCalledTimes(2)
      engine.stop()
      refreshSpy.mockRestore()
    })
  })

  describe('HookEvent type', () => {
    it('accepts all valid event types', () => {
      const events: HookEvent[] = [
        { type: 'pod_crashloop', payload: { pod_name: 'test' } },
        { type: 'pod_oom', payload: { pod_name: 'test' } },
        { type: 'node_disk_full', payload: { node: 'node1' } },
        { type: 'sync_degraded', payload: { app: 'my-app' } },
        { type: 'tool_execution', payload: { tool: 'kubectl' } },
      ]
      for (const event of events) {
        expect(event.type).toBeDefined()
        expect(event.payload).toBeDefined()
      }
    })
  })
})
