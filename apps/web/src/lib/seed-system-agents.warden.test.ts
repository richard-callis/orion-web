/**
 * Tests for the Warden seed (PR #412 P4 fixes).
 *
 * Covers:
 *   B1 — Warden routes ALL write actions through security_propose_action
 *   B2 — Warden must ship with an explicit allowedTools whitelist (no full registry)
 *   B3 — Prompt must NOT instruct direct write tool calls
 */

import { describe, it, expect } from 'vitest'
import { SYSTEM_AGENT_DEFS } from './seed-system-agents'

const warden = SYSTEM_AGENT_DEFS.find(d => d.nova.name === 'warden')!

describe('Warden seed', () => {
  it('Warden definition exists', () => {
    expect(warden).toBeDefined()
    expect(warden.nova.displayName).toBe('Warden')
  })

  describe('B1 — all write actions go through security_propose_action', () => {
    it('prompt instructs Warden to use security_propose_action for write actions', () => {
      const prompt = warden.agent.systemPrompt
      expect(prompt).toContain('security_propose_action')
      // "policy" and "engine" are on consecutive lines
      expect(prompt).toMatch(/policy\s+engine/)
    })

    it('prompt does NOT instruct direct write tool calls', () => {
      const prompt = warden.agent.systemPrompt
      // The prompt should NOT contain instructions like "call orion_call_tool with
      // tool name crowdsec_decision_create" — all writes go through security_propose_action
      expect(prompt).not.toContain('tool name crowdsec_decision_create')
      expect(prompt).not.toContain('tool name crowdsec_decision_delete')
      expect(prompt).not.toContain('tool name wazuh_active_response')
      expect(prompt).not.toContain('tool name firewall_block')
    })

    it('prompt warns against calling write tools directly', () => {
      const prompt = warden.agent.systemPrompt
      // The prompt uses "NEVER call write tools (... directly)" across two lines
      expect(prompt).toContain('NEVER call write tools')
      expect(prompt).toContain('directly')
    })
  })

  describe('B2 — tool whitelist (no full registry)', () => {
    it('contextConfig.allowedTools is a non-empty array', () => {
      const allowed = (warden.agent.contextConfig as Record<string, unknown>).allowedTools
      expect(Array.isArray(allowed)).toBe(true)
      expect((allowed as string[]).length).toBeGreaterThan(0)
    })

    it('whitelist does NOT include arbitrary-code-execution tools', () => {
      const allowed = (warden.agent.contextConfig as Record<string, unknown>).allowedTools as string[]
      expect(allowed).not.toContain('orion_create_agent')
      expect(allowed).not.toContain('orion_update_agent')
      expect(allowed).not.toContain('orion_archive_agent')
      expect(allowed).not.toContain('gitops_propose')
      expect(allowed).not.toContain('write_secret')
      expect(allowed).not.toContain('shell_exec')
      expect(allowed).not.toContain('kubectl_logs')
    })

    it('whitelist includes security_propose_action and read tools (NOT direct write tools)', () => {
      const allowed = (warden.agent.contextConfig as Record<string, unknown>).allowedTools as string[]
      // All writes go through security_propose_action — direct write tools excluded
      expect(allowed).toContain('security_propose_action')
      expect(allowed).not.toContain('crowdsec_decision_create')
      expect(allowed).not.toContain('crowdsec_decision_delete')
      expect(allowed).not.toContain('wazuh_active_response')
      expect(allowed).not.toContain('firewall_block')
      // Read tools still allowed
      expect(allowed).toContain('elk_flow_search')
      expect(allowed).toContain('chat_post')
    })
  })

  describe('B3 — prompt copy-paste bug', () => {
    it('crowdsec_decision_delete instruction does NOT tell Warden to call crowdsec_decision_create', () => {
      const prompt = warden.agent.systemPrompt
      const lines = prompt.split('\n')
      const deleteLine = lines.find(l => l.includes('crowdsec_decision_delete'))
      expect(deleteLine).toBeDefined()
      expect(deleteLine!.toLowerCase()).toContain('crowdsec_decision_delete')
      const tail = deleteLine!.split('tool name')[1] ?? ''
      expect(tail.toLowerCase()).not.toContain('crowdsec_decision_create')
    })
  })
})
