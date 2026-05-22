/**
 * Tests for the Warden seed (PR #412 P4 fixes).
 *
 * Covers:
 *   B2 — Warden must ship with an explicit allowedTools whitelist (no full registry)
 *   B3 — Prompt must NOT instruct crowdsec_decision_delete to call crowdsec_decision_create
 */

import { describe, it, expect } from 'vitest'
import { SYSTEM_AGENT_DEFS } from './seed-system-agents'

const warden = SYSTEM_AGENT_DEFS.find(d => d.nova.name === 'warden')!

describe('Warden seed', () => {
  it('Warden definition exists', () => {
    expect(warden).toBeDefined()
    expect(warden.nova.displayName).toBe('Warden')
  })

  describe('B2 — tool whitelist (no full registry)', () => {
    it('contextConfig.allowedTools is a non-empty array', () => {
      const allowed = (warden.agent.contextConfig as Record<string, unknown>).allowedTools
      expect(Array.isArray(allowed)).toBe(true)
      expect((allowed as string[]).length).toBeGreaterThan(0)
    })

    it('whitelist does NOT include arbitrary-code-execution tools', () => {
      const allowed = (warden.agent.contextConfig as Record<string, unknown>).allowedTools as string[]
      // Per SIEM Review B2: a jailbroken Warden with tools:true could call
      // orion_create_agent, orion_archive_agent, gitops_propose, write_secret.
      // None of those may be in the whitelist.
      expect(allowed).not.toContain('orion_create_agent')
      expect(allowed).not.toContain('orion_update_agent')
      expect(allowed).not.toContain('orion_archive_agent')
      expect(allowed).not.toContain('gitops_propose')
      expect(allowed).not.toContain('write_secret')
      expect(allowed).not.toContain('shell_exec')
      expect(allowed).not.toContain('kubectl_logs')
    })

    it('whitelist includes the security read+write tools and chat_post', () => {
      const allowed = (warden.agent.contextConfig as Record<string, unknown>).allowedTools as string[]
      // Per SIEM_PLAN.md P4: "tool whitelist: all security read + write tools + chat_post"
      expect(allowed).toContain('crowdsec_decision_create')
      expect(allowed).toContain('crowdsec_decision_delete')
      expect(allowed).toContain('wazuh_active_response')
      expect(allowed).toContain('firewall_block')
      expect(allowed).toContain('elk_flow_search')
      expect(allowed).toContain('chat_post')
    })
  })

  describe('B3 — prompt copy-paste bug', () => {
    it('crowdsec_decision_delete instruction does NOT tell Warden to call crowdsec_decision_create', () => {
      const prompt = warden.agent.systemPrompt
      // Find the line about crowdsec_decision_delete
      const lines = prompt.split('\n')
      const deleteLine = lines.find(l => l.includes('crowdsec_decision_delete'))
      expect(deleteLine).toBeDefined()
      // The instruction for decision_delete must reference decision_delete, not _create
      expect(deleteLine!.toLowerCase()).toContain('crowdsec_decision_delete')
      // The pre-fix bug: the body said "tool name crowdsec_decision_create"
      // for the decision_delete bullet. The fix must invoke decision_delete.
      const tail = deleteLine!.split('tool name')[1] ?? ''
      expect(tail.toLowerCase()).not.toContain('crowdsec_decision_create')
    })
  })
})
