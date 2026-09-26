import { describe, it, expect } from 'vitest'
import { resolveRestTool } from './tool-policy'
import type { McpToolConfig } from '../orion-client'

const cfg = (name: string, builtIn: boolean): McpToolConfig => ({
  id: name, name, description: '', inputSchema: {}, execType: builtIn ? 'builtin' : 'shell',
  execConfig: null, enabled: true, builtIn,
})

const registry = { shell_exec: { name: 'shell_exec' }, kubectl_get: { name: 'kubectl_get' } }

describe('resolveRestTool (fail-closed /tools/execute policy)', () => {
  it('returns 503 before the tool policy has loaded — even for built-ins', () => {
    const d = resolveRestTool('shell_exec', { toolsLoaded: false, activeTools: [], registry })
    expect(d.kind).toBe('unavailable')
    expect('status' in d && d.status).toBe(503)
  })

  it('forbids every built-in when ORION has disabled all tools (empty list, loaded)', () => {
    // The old code treated an empty list as "not loaded yet" and allowed everything.
    const d = resolveRestTool('shell_exec', { toolsLoaded: true, activeTools: [], registry })
    expect(d.kind).toBe('forbidden')
    expect('status' in d && d.status).toBe(403)
  })

  it('forbids a built-in that is not in the active policy', () => {
    const d = resolveRestTool('shell_exec', { toolsLoaded: true, activeTools: [cfg('kubectl_get', true)], registry })
    expect(d.kind).toBe('forbidden')
  })

  it('allows an enabled built-in', () => {
    const d = resolveRestTool('kubectl_get', { toolsLoaded: true, activeTools: [cfg('kubectl_get', true)], registry })
    expect(d.kind).toBe('builtin')
  })

  it('runs an enabled custom tool', () => {
    const d = resolveRestTool('my_tool', { toolsLoaded: true, activeTools: [cfg('my_tool', false)], registry })
    expect(d.kind).toBe('custom')
  })

  it('404s unknown tools and built-ins not present on this gateway type', () => {
    expect(resolveRestTool('nope', { toolsLoaded: true, activeTools: [], registry }).kind).toBe('unknown')
    expect(resolveRestTool('talos_reboot', { toolsLoaded: true, activeTools: [cfg('talos_reboot', true)], registry }).kind).toBe('unknown')
  })

  it('does not resolve prototype keys as built-ins', () => {
    expect(resolveRestTool('constructor', { toolsLoaded: true, activeTools: [], registry }).kind).toBe('unknown')
  })
})
