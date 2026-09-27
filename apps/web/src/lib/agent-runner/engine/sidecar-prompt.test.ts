/**
 * The structured sidecar request must reproduce the exact prompt ORION used to
 * flatten itself, and put volatile context in the user turn (not the cached
 * system prompt). Cross-checks apps/web's request builder against the
 * sidecar's own renderer (deploy/orion-claude/prompt.js).
 */
import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
import { buildSidecarBody, renderLegacyPrompt, type SidecarRequest } from './providers/claude-sidecar'

interface SidecarPromptModule {
  resolvePrompt(opts: Record<string, unknown>): { prompt: string; systemPrompt?: string }
  toolArgs(allowed: unknown): string[]
  mcpTokenFor(opts: Record<string, unknown>, fallback: string): string
  parseUsage(parsed: unknown): Record<string, number> | undefined
}
const sidecar = createRequire(import.meta.url)('../../../../../../deploy/orion-claude/prompt.js') as SidecarPromptModule

const chatReq: SidecarRequest = {
  system: 'STABLE',
  messages: [
    { role: 'user', content: 'earlier q' },
    { role: 'assistant', content: 'earlier a' },
    { role: 'user', content: 'now?' },
  ],
  transcript: 'chat',
}

describe('sidecar prompt rendering', () => {
  it('chat transcript is byte-identical to the old flattened prompt', () => {
    const legacy = 'user: earlier q\n\nassistant: earlier a\n\nuser: now?'
    expect(renderLegacyPrompt(chatReq)).toBe(legacy)
    expect(sidecar.resolvePrompt(buildSidecarBody(chatReq))).toEqual({ prompt: legacy, systemPrompt: 'STABLE' })
  })

  it('room transcript: "Name: content" lines, then the latest message', () => {
    const req: SidecarRequest = {
      system: 'S',
      messages: [
        { role: 'user', content: 'hi team', name: 'Alice' },
        { role: 'assistant', content: 'hello', name: 'Bot' },
        { role: 'user', content: 'Alice: status?' },
      ],
      transcript: 'room',
    }
    const legacy = 'Alice: hi team\nBot: hello\n\nAlice: status?'
    expect(renderLegacyPrompt(req)).toBe(legacy)
    expect(sidecar.resolvePrompt(buildSidecarBody(req)).prompt).toBe(legacy)
  })

  it('single message → the message itself', () => {
    const req: SidecarRequest = { messages: [{ role: 'user', content: 'just this' }] }
    expect(sidecar.resolvePrompt(buildSidecarBody(req))).toEqual({ prompt: 'just this', systemPrompt: undefined })
  })

  it('volatile context goes in the user turn; the system prompt stays stable', () => {
    const body = buildSidecarBody({ ...chatReq, context: '\n\n---\n## INJECTED SKILL: s\ndo X\n---' })
    // Legacy fields (old sidecars) still carry the combined system prompt
    expect(body.systemPrompt).toBe('STABLE\n\n---\n## INJECTED SKILL: s\ndo X\n---')
    const resolved = sidecar.resolvePrompt(body)
    expect(resolved.systemPrompt).toBe('STABLE')
    expect(resolved.prompt).toBe('Context for this turn:\n---\n## INJECTED SKILL: s\ndo X\n---\n\n---\n\nuser: earlier q\n\nassistant: earlier a\n\nuser: now?')
  })

  it('legacy requests pass through unchanged', () => {
    expect(sidecar.resolvePrompt({ prompt: 'p', systemPrompt: 'sp' })).toEqual({ prompt: 'p', systemPrompt: 'sp' })
  })
})

describe('sidecar tool allowlist flags', () => {
  it('absent → CLI default; empty → no built-in tools; list → --allowedTools', () => {
    expect(sidecar.toolArgs(undefined)).toEqual([])
    expect(sidecar.toolArgs([])).toEqual(['--tools', ''])
    expect(sidecar.toolArgs(['Bash(kubectl get:*)', 'Read'])).toEqual(['--allowedTools', 'Bash(kubectl get:*)', 'Read'])
  })

  it('never lets an entry smuggle in a flag', () => {
    expect(sidecar.toolArgs(['--dangerously-skip-permissions'])).toEqual(['--tools', ''])
    expect(sidecar.toolArgs(['Read', '-x', 'a\nb'])).toEqual(['--allowedTools', 'Read'])
  })
})

describe('sidecar usage + MCP token', () => {
  it('usage includes cache reads/writes in the prompt size and reports them separately', () => {
    expect(sidecar.parseUsage({ usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 90 } }))
      .toEqual({ inputTokens: 1000, outputTokens: 5, cacheReadInputTokens: 900, cacheCreationInputTokens: 90 })
    expect(sidecar.parseUsage({ result: 'x' })).toBeUndefined()
  })

  it('per-agent MCP token wins; malformed tokens fall back to the service token', () => {
    expect(sidecar.mcpTokenFor({ mcpToken: 'agent-tok' }, 'svc')).toBe('agent-tok')
    expect(sidecar.mcpTokenFor({ mcpToken: 'bad\ntoken' }, 'svc')).toBe('svc')
    expect(sidecar.mcpTokenFor({}, 'svc')).toBe('svc')
  })
})
