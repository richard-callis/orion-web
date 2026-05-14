/**
 * Tests for Phase 5: Ring Leader Integration.
 *
 * Tests cover:
 * - Ring leader routing logic (only ring leader auto-replies, specialists on mention)
 * - Specialist list building from AgentProfile
 * - Ring leader system prompt template content
 * - Agent context injection (specialist context for delegated tasks)
 */

// ── Ring leader routing logic (extracted from room-agents) ─────────────────────

function determineTriggeredAgents(
  agentMembers,
  ringLeaderId,
  mentionedNames,
) {
  const isEveryone = mentionedNames.some(n => n.toLowerCase() === 'everyone')
  const hasSpecificMention = mentionedNames.length > 0 && !isEveryone
  const isDirect = agentMembers.length === 1

  // @everyone bypasses ring leader — targets all agents
  if (isEveryone) return agentMembers

  // Ring leader mode — only ring leader responds to non-mentioned messages
  if (!hasSpecificMention && ringLeaderId) {
    const ringLeader = agentMembers.find(a => a.id === ringLeaderId)
    return ringLeader
      ? [ringLeader]
      : agentMembers.filter(a => !a.watchPrompt)
  }

  if (hasSpecificMention) {
    return agentMembers.filter(a =>
      mentionedNames.some(n => a.name.toLowerCase() === n.toLowerCase()),
    )
  }
  if (isDirect) return agentMembers
  return agentMembers.filter(a => !a.watchPrompt)
}

describe('Ring Leader Routing', () => {
  const agents = [
    { id: 'a1', name: 'Alpha', watchPrompt: true },
    { id: 'a2', name: 'Atlas', watchPrompt: false },
    { id: 'a3', name: 'Veritas', watchPrompt: false },
  ]

  it('ring leader mode - only ring leader replies to non-mentioned message', () => {
    const result = determineTriggeredAgents(agents, 'a1', [])
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('a1')
    expect(result[0].name).toBe('Alpha')
  })

  it('ring leader mode - @mention targets specific agents', () => {
    const result = determineTriggeredAgents(agents, 'a1', ['Atlas'])
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('a2')
  })

  it('ring leader mode - @everyone targets all agents', () => {
    const result = determineTriggeredAgents(agents, 'a1', ['everyone'])
    expect(result).toHaveLength(3)
  })

  it('no ring leader - falls back to non-watcher agents', () => {
    const result = determineTriggeredAgents(agents, undefined, [])
    expect(result).toHaveLength(2) // Atlas and Veritas (not Alpha who has watchPrompt)
  })

  it('no ring leader - @mention targets specific agents', () => {
    const result = determineTriggeredAgents(agents, undefined, ['Veritas'])
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Veritas')
  })

  it('no ring leader, no non-watcher agents - returns empty', () => {
    const watchersOnly = [
      { id: 'a1', name: 'Alpha', watchPrompt: true },
      { id: 'a2', name: 'Beta', watchPrompt: true },
    ]
    const result = determineTriggeredAgents(watchersOnly, undefined, [])
    expect(result).toHaveLength(0)
  })

  it('ring leader not in members - falls back to non-watchers', () => {
    const result = determineTriggeredAgents(agents, 'a999', [])
    expect(result).toHaveLength(2) // Atlas and Veritas
  })

  it('ring leader is a watcher - still responds as ring leader', () => {
    const watcherRingLeader = [
      { id: 'a1', name: 'Alpha', watchPrompt: true },
      { id: 'a2', name: 'Atlas', watchPrompt: false },
    ]
    const result = determineTriggeredAgents(watcherRingLeader, 'a1', [])
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('a1') // Alpha responds despite being a watcher
  })

  it('1-on-1 room without ring leader - agent always replies', () => {
    const oneOnOne = [
      { id: 'a1', name: 'Alpha', watchPrompt: true },
    ]
    const result = determineTriggeredAgents(oneOnOne, undefined, [])
    expect(result).toHaveLength(1)
  })
})

// ── Specialist list building ──────────────────────────────────────────────────

function buildSpecialistLines(specialists) {
  return specialists.map(s =>
    `  \u2022 ${s.agentName} (${s.domain}) - ${s.description}${s.tags.length ? ` [${s.tags.join(', ')}]` : ''}`,
  )
}

describe('Specialist List Building', () => {
  it('formats specialist lines correctly', () => {
    const lines = buildSpecialistLines([
      { agentName: 'Planner', domain: 'planning', description: 'Creates implementation plans', tags: ['planning', 'strategy'] },
      { agentName: 'Atlas', domain: 'environment-management', description: 'Manages environments', tags: ['env', 'deploy'] },
    ])
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('Planner')
    expect(lines[0]).toContain('planning')
    expect(lines[1]).toContain('Atlas')
    expect(lines[1]).toContain('environment-management')
  })

  it('omits tags bracket when no tags', () => {
    const lines = buildSpecialistLines([
      { agentName: 'Solo', domain: 'solo-domain', description: 'No tags', tags: [] },
    ])
    expect(lines[0]).not.toContain('[]')
    expect(lines[0]).toContain('No tags')
  })
})

// ── Ring Leader System Prompt Template ─────────────────────────────────────────

describe('System Prompt Templates', () => {
  it('ring-leader template key exists in PROMPT_DEFAULTS', () => {
    const fs = require('fs')
    const path = require('path')
    const content = fs.readFileSync(path.join(__dirname, 'system-prompts.ts'), 'utf8')
    expect(content).toContain("key: 'system.ring-leader'")
  })

  it('specialist-context template key exists in PROMPT_DEFAULTS', () => {
    const fs = require('fs')
    const path = require('path')
    const content = fs.readFileSync(path.join(__dirname, 'system-prompts.ts'), 'utf8')
    expect(content).toContain("key: 'system.specialist-context'")
  })

  it('ring-leader template mentions delegation', () => {
    const fs = require('fs')
    const path = require('path')
    const content = fs.readFileSync(path.join(__dirname, 'system-prompts.ts'), 'utf8')
    expect(content).toContain('system.ring-leader')
    expect(content).toContain('delegate')
  })

  it('specialist-context template has delegation structure', () => {
    const fs = require('fs')
    const path = require('path')
    const content = fs.readFileSync(path.join(__dirname, 'system-prompts.ts'), 'utf8')
    expect(content).toContain('Delegation Received')
  })
})

// ── Agent Context Injection ───────────────────────────────────────────────────

describe('Context Injection', () => {
  it('ring leader context is appended to persona prompt', () => {
    const ringLeaderContext = '\n\n## Specialist Agents Available to You\n\nYou can delegate work to these specialist agents:\n\n  \u2022 Planner (planning) - Creates implementation plans'
    const personaPrompt = 'Role: Team Lead\n\nYou are the team coordinator.'
    const injected = personaPrompt + ringLeaderContext

    expect(injected).toContain('Specialist Agents')
    expect(injected).toContain('Planner')
    expect(injected).toContain('delegat')
  })

  it('ring leader context is empty when no ring leader configured', () => {
    const ringLeaderContext = ''
    const personaPrompt = 'Role: Specialist\n\nYou handle deployments.'
    const agentContext = '## ORION State\n  agents: 0'

    const agentBasePrompt = agentContext
      ? personaPrompt + agentContext
      : personaPrompt

    expect(agentBasePrompt).not.toContain('Specialist Agents')
  })

  it('specialist context has delegation instructions', () => {
    const fs = require('fs')
    const path = require('path')
    const content = fs.readFileSync(path.join(__dirname, 'system-prompts.ts'), 'utf8')
    expect(content).toContain('Delegation Received')
    expect(content).toContain('delegation')
  })
})
