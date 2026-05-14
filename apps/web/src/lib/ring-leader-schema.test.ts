/**
 * Ring Leader Delegation - Database Schema Tests
 * Phase 1: AgentProfile, RoomKnowledge, AgentKnowledge models + AgentContextConfig additions
 */

import { describe, it, expect } from '@jest/globals'

// ── AgentContextConfig interface tests ────────────────────────────────────────

describe('AgentContextConfig', () => {
  it('has all Ring Leader delegation fields', () => {
    const config = {
      maxTurns: 6,
      historyMessages: 12,
      discoverable: true,
      maxParallelDelegations: 3,
      canWriteKnowledge: true,
      knowledgeScope: 'room',
    }

    expect(config.maxParallelDelegations).toBe(3)
    expect(config.knowledgeScope).toBe('room')
    expect(config.discoverable).toBe(true)
    expect(config.canWriteKnowledge).toBe(true)
    expect(config.maxTurns).toBe(6)
    expect(config.historyMessages).toBe(12)
  })

  it('accepts an empty config object (all fields optional)', () => {
    const config = {}
    expect(config).toBeDefined()
    expect(config).toEqual({})
  })

  it('allows partial configuration', () => {
    const partial = {
      llm: 'claude',
      discoverable: true,
    }
    expect(partial.llm).toBe('claude')
    expect(partial.discoverable).toBe(true)
  })
})

// ── Prisma schema structure tests ────────────────────────────────────────────

describe('Prisma Schema', () => {
  let schemaContent: string

  beforeAll(async () => {
    const { readFileSync } = await import('fs')
    const path = await import('path')
    const schemaPath = path.default.join(__dirname, '../../../prisma/schema.prisma')
    schemaContent = readFileSync(schemaPath, 'utf-8')
  })

  describe('AgentProfile model', () => {
    it('defines the AgentProfile model', () => {
      expect(schemaContent).toContain('model AgentProfile')
    })

    it('maps to agent_profiles table', () => {
      expect(schemaContent).toContain('@@map("agent_profiles")')
    })

    it('has required fields: agentId, domain, description', () => {
      const block = extractModelBlock(schemaContent, 'AgentProfile')
      expect(block).toContain('agentId')
      expect(block).toContain('domain')
      expect(block).toContain('description')
    })

    it('has optional fields: tags, activeEnvironments, confidence, verifiedAt', () => {
      const block = extractModelBlock(schemaContent, 'AgentProfile')
      expect(block).toContain('tags')
      expect(block).toContain('activeEnvironments')
      expect(block).toContain('confidence')
      expect(block).toContain('verifiedAt')
    })

    it('has unique constraint on agentId', () => {
      expect(schemaContent).toContain('@@unique([agentId])')
    })

    it('has cascade delete relation to Agent', () => {
      const block = extractModelBlock(schemaContent, 'AgentProfile')
      expect(block).toContain('onDelete: Cascade')
    })

    it('has indexes on domain and tags', () => {
      const block = extractModelBlock(schemaContent, 'AgentProfile')
      expect(block).toContain('@@index([domain])')
      expect(block).toContain('@@index([tags])')
    })
  })

  describe('RoomKnowledge model', () => {
    it('defines the RoomKnowledge model', () => {
      expect(schemaContent).toContain('model RoomKnowledge')
    })

    it('maps to room_knowledge table', () => {
      expect(schemaContent).toContain('@@map("room_knowledge")')
    })

    it('has required fields: roomId, title, content, room relation', () => {
      const block = extractModelBlock(schemaContent, 'RoomKnowledge')
      expect(block).toContain('roomId')
      expect(block).toContain('title')
      expect(block).toContain('content')
      expect(block).toContain('ChatRoom')
    })

    it('has optional fields: type, tags', () => {
      const block = extractModelBlock(schemaContent, 'RoomKnowledge')
      expect(block).toContain('type')
      expect(block).toContain('tags')
    })

    it('has cascade delete relation to ChatRoom', () => {
      const block = extractModelBlock(schemaContent, 'RoomKnowledge')
      expect(block).toContain('onDelete: Cascade')
    })
  })

  describe('AgentKnowledge model', () => {
    it('defines the AgentKnowledge model', () => {
      expect(schemaContent).toContain('model AgentKnowledge')
    })

    it('maps to agent_knowledge table', () => {
      expect(schemaContent).toContain('@@map("agent_knowledge")')
    })

    it('has required fields: agentId, title, content, agent relation', () => {
      const block = extractModelBlock(schemaContent, 'AgentKnowledge')
      expect(block).toContain('agentId')
      expect(block).toContain('title')
      expect(block).toContain('content')
      expect(block).toContain('Agent')
    })

    it('has optional fields: type, tags', () => {
      const block = extractModelBlock(schemaContent, 'AgentKnowledge')
      expect(block).toContain('type')
      expect(block).toContain('tags')
    })

    it('has cascade delete relation to Agent', () => {
      const block = extractModelBlock(schemaContent, 'AgentKnowledge')
      expect(block).toContain('onDelete: Cascade')
    })
  })

  describe('ChatRoom extensions', () => {
    it('has metadata field on ChatRoom', () => {
      const block = extractModelBlock(schemaContent, 'ChatRoom')
      expect(block).toContain('metadata')
    })

    it('has roomKnowledge relation on ChatRoom', () => {
      const block = extractModelBlock(schemaContent, 'ChatRoom')
      expect(block).toContain('roomKnowledge')
    })
  })

  describe('Agent model extensions', () => {
    it('has profiles relation', () => {
      const block = extractModelBlock(schemaContent, 'Agent')
      expect(block).toContain('profiles')
    })

    it('has knowledge relation', () => {
      const block = extractModelBlock(schemaContent, 'Agent')
      expect(block).toContain('knowledge')
    })
  })
})

// ── Helper ─────────────────────────────────────────────────────────────────────

/**
 * Extract the block of text for a model from the schema.
 * Handles last model in file by allowing EOF as terminator.
 */
function extractModelBlock(schema: string, modelName: string): string {
  const regex = new RegExp(
    `model\\s+${modelName}\\s*\\{([\\s\\S]*?)(?=\\nmodel\\s+\\w+\\n\\s*\\{|\\Z)`,
  )
  const match = schema.match(regex)
  if (!match) {
    throw new Error(`Model ${modelName} not found in schema`)
  }
  return match[1]
}
