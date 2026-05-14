import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SkillLoader, type SkillMatch } from './skill-loader'

// Mock OrionClient
function createMockOrionClient() {
  return {
    fetchNebula: vi.fn(),
  }
}

describe('SkillLoader', () => {
  let loader: SkillLoader
  let mockClient: ReturnType<typeof createMockOrionClient>

  beforeEach(() => {
    loader = new SkillLoader()
    mockClient = createMockOrionClient()
  })

  describe('load', () => {
    it('stores installed skills for an environment', async () => {
      const skills = [
        { id: 's1', name: 'k8s-debug', category: 'skill', isInstalled: true, spec: JSON.stringify({ triggerPatterns: ['pod', 'crash'] }) },
        { id: 's2', name: 'docker-troubleshoot', category: 'skill', isInstalled: true, spec: JSON.stringify({ triggerPatterns: ['docker'] }) },
        { id: 's3', name: 'unused-skill', category: 'skill', isInstalled: false, spec: JSON.stringify({ triggerPatterns: ['x'] }) },
        { id: 's4', name: 'hook-def', category: 'hook', isInstalled: true, spec: JSON.stringify({ triggerPatterns: ['y'] }) },
      ]
      mockClient.fetchNebula.mockResolvedValue(skills)

      await loader.load('env1', mockClient)

      const stored = loader['skills'].get('env1')
      expect(stored).toHaveLength(2)
      expect(stored!.find(s => s.name === 'k8s-debug')).toBeDefined()
      expect(stored!.find(s => s.name === 'docker-troubleshoot')).toBeDefined()
      expect(stored!.find(s => s.name === 'unused-skill')).toBeUndefined()
      expect(stored!.find(s => s.name === 'hook-def')).toBeUndefined()
    })

    it('stores empty array when no skills returned', async () => {
      mockClient.fetchNebula.mockResolvedValue([])
      await loader.load('env2', mockClient)
      expect(loader['skills'].get('env2')).toEqual([])
    })

    it('overwrites previous skills for same environment', async () => {
      mockClient.fetchNebula.mockResolvedValue([{ id: 'old', name: 'old', category: 'skill', isInstalled: true, spec: '{}' }])
      await loader.load('env1', mockClient)

      mockClient.fetchNebula.mockResolvedValue([{ id: 'new', name: 'new', category: 'skill', isInstalled: true, spec: '{}' }])
      await loader.load('env1', mockClient)

      const stored = loader['skills'].get('env1')
      expect(stored).toHaveLength(1)
      expect(stored![0].name).toBe('new')
    })
  })

  describe('match', () => {
    it('returns SkillMatch when message matches a trigger pattern', () => {
      const skills = [
        { id: 's1', name: 'k8s-debug', category: 'skill', isInstalled: true, spec: JSON.stringify({
          triggerPatterns: ['pod crash', 'restart'],
          systemPrompt: 'You are a k8s debug assistant.',
        }) },
      ]
      loader['skills'].set('env1', skills)

      const result = loader.match('env1', 'My pod keeps crashing and restarting')

      expect(result).not.toBeNull()
      expect(result!.skillName).toBe('k8s-debug')
      expect(result!.systemPrompt).toBe('You are a k8s debug assistant.')
      expect(result!.nebulaId).toBe('s1')
    })

    it('returns null when no pattern matches', () => {
      const skills = [
        { id: 's1', name: 'k8s-debug', category: 'skill', isInstalled: true, spec: JSON.stringify({
          triggerPatterns: ['pod crash'],
          systemPrompt: 'Debug prompt',
        }) },
      ]
      loader['skills'].set('env1', skills)

      const result = loader.match('env1', 'hello world')

      expect(result).toBeNull()
    })

    it('handles case-insensitive pattern matching', () => {
      const skills = [
        { id: 's1', name: 'test', category: 'skill', isInstalled: true, spec: JSON.stringify({
          triggerPatterns: ['POD CRASH'],
          systemPrompt: 'test',
        }) },
      ]
      loader['skills'].set('env1', skills)

      const result = loader.match('env1', 'pod crash detected')

      expect(result).not.toBeNull()
      expect(result!.skillName).toBe('test')
    })

    it('returns first matching skill only', () => {
      const skills = [
        { id: 's1', name: 'first-skill', category: 'skill', isInstalled: true, spec: JSON.stringify({
          triggerPatterns: ['error'],
          systemPrompt: 'First',
        }) },
        { id: 's2', name: 'second-skill', category: 'skill', isInstalled: true, spec: JSON.stringify({
          triggerPatterns: ['error'],
          systemPrompt: 'Second',
        }) },
      ]
      loader['skills'].set('env1', skills)

      const result = loader.match('env1', 'an error occurred')

      expect(result).not.toBeNull()
      expect(result!.skillName).toBe('first-skill')
    })

    it('returns empty string for systemPrompt when not in spec', () => {
      const skills = [
        { id: 's1', name: 'no-prompt', category: 'skill', isInstalled: true, spec: JSON.stringify({
          triggerPatterns: ['test'],
        }) },
      ]
      loader['skills'].set('env1', skills)

      const result = loader.match('env1', 'test message')

      expect(result).not.toBeNull()
      expect(result!.systemPrompt).toBe('')
    })

    it('returns null for unknown environment', () => {
      const result = loader.match('unknown-env', 'anything')
      expect(result).toBeNull()
    })

    it('skills with no triggerPatterns are skipped', () => {
      const skills = [
        { id: 's1', name: 'no-patterns', category: 'skill', isInstalled: true, spec: JSON.stringify({
          systemPrompt: 'some prompt',
        }) },
      ]
      loader['skills'].set('env1', skills)

      const result = loader.match('env1', 'test')
      expect(result).toBeNull()
    })

    it('handles empty skills array', () => {
      loader['skills'].set('env1', [])
      expect(loader.match('env1', 'anything')).toBeNull()
    })

    it('matches on partial pattern (substring)', () => {
      const skills = [
        { id: 's1', name: 'partial', category: 'skill', isInstalled: true, spec: JSON.stringify({
          triggerPatterns: ['network error'],
          systemPrompt: 'network skill',
        }) },
      ]
      loader['skills'].set('env1', skills)

      const result = loader.match('env1', 'i have a network error connection')
      expect(result).not.toBeNull()
      expect(result!.skillName).toBe('partial')
    })
  })

  describe('refresh', () => {
    it('delegates to load', async () => {
      mockClient.fetchNebula.mockResolvedValue([])
      await loader.refresh('env1', mockClient)

      expect(mockClient.fetchNebula).toHaveBeenCalledWith('env1')
      expect(loader['skills'].get('env1')).toEqual([])
    })
  })
})
