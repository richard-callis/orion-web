import { describe, it, expect } from 'vitest'
import { validateShellTemplate, runTool } from './tool-runner'
import type { McpToolConfig } from './orion-client'

describe('validateShellTemplate', () => {
  it('accepts placeholders outside quotes', () => {
    expect(validateShellTemplate('nslookup {host}')).toBeNull()
    expect(validateShellTemplate('echo "prefix:" {x} \'literal\'')).toBeNull()
  })

  it('rejects placeholders inside double quotes (quote() output would still expand $(…))', () => {
    expect(validateShellTemplate('echo "{x}"')).toMatch(/double quotes/)
  })

  it('rejects placeholders inside single quotes (value would land unquoted)', () => {
    expect(validateShellTemplate("echo '{x}'")).toMatch(/single quotes/)
  })

  it('handles escaped quotes and unterminated quotes', () => {
    expect(validateShellTemplate('echo \\"{x}\\"')).toBeNull()
    expect(validateShellTemplate('echo "unterminated {x}')).not.toBeNull()
  })
})

describe('runTool shell templates', () => {
  const shellTool = (command: string): McpToolConfig => ({
    id: 't', name: 't', description: '', inputSchema: { required: ['x'] },
    execType: 'shell', execConfig: { command }, enabled: true, builtIn: false,
  })

  it('refuses to run an unsafe template', async () => {
    await expect(runTool(shellTool('echo "{x}"'), { x: '$(id)' })).rejects.toThrow(/unsafe command template/)
  })

  it('passes hostile input through as a single literal argument', async () => {
    const out = await runTool(shellTool('printf %s {x}'), { x: "$(echo pwned); 'quoted' `id`" })
    expect(out).toBe("$(echo pwned); 'quoted' `id`")
  })
})
