import { describe, it, expect } from 'vitest'
import { DEFAULT_NOVAS, type NovaDefinitionSeed } from './default-novas'
import { DEFAULT_RULESETS, type RulesetSeed } from './default-rulesets'

describe('Seed Data', () => {
  describe('Nova Definitions', () => {
    it('exports exactly 10 novas (5 skills + 5 hooks)', () => {
      expect(DEFAULT_NOVAS).toHaveLength(10)
      const skills = DEFAULT_NOVAS.filter(n => n.category === 'skill')
      const hooks = DEFAULT_NOVAS.filter(n => n.category === 'hook')
      expect(skills).toHaveLength(5)
      expect(hooks).toHaveLength(5)
    })

    it('all novas have unique names', () => {
      const names = DEFAULT_NOVAS.map(n => n.name)
      const unique = new Set(names)
      expect(unique.size).toBe(names.length)
    })

    it('all novas have required fields', () => {
      for (const nova of DEFAULT_NOVAS) {
        expect(nova.name).toBeTruthy()
        expect(['skill', 'hook']).toContain(nova.category)
        expect(nova.version).toBeTruthy()
        expect(nova.title).toBeTruthy()
        expect(nova.description).toBeTruthy()
        expect(nova.spec).toBeTruthy()
        expect(nova.metadata).toBeTruthy()
      }
    })

    it('all spec fields are valid JSON', () => {
      for (const nova of DEFAULT_NOVAS) {
        expect(() => JSON.parse(nova.spec)).not.toThrow()
        expect(() => JSON.parse(nova.metadata)).not.toThrow()
      }
    })

    describe('Skills', () => {
      const skills = DEFAULT_NOVAS.filter(n => n.category === 'skill') as Array<NovaDefinitionSeed & { spec: { triggerPatterns: string[], systemPrompt: string } }>

      it('skills have triggerPatterns and systemPrompt in spec', () => {
        for (const skill of skills) {
          const spec = JSON.parse(skill.spec)
          expect(Array.isArray(spec.triggerPatterns)).toBe(true)
          expect(spec.triggerPatterns.length).toBeGreaterThan(0)
          expect(typeof spec.systemPrompt).toBe('string')
          expect(spec.systemPrompt.length).toBeGreaterThan(50)
        }
      })

      it('skill names match expected list', () => {
        const names = skills.map(s => s.name).sort()
        expect(names).toEqual([
          'backup-recovery',
          'cluster-health',
          'dns-troubleshoot',
          'docker-troubleshoot',
          'k8s-debug',
        ])
      })
    })

    describe('Hooks', () => {
      const hooks = DEFAULT_NOVAS.filter(n => n.category === 'hook')
      function parseSpec(nova: { spec: string }) {
        return JSON.parse(nova.spec) as Record<string, unknown>
      }

      it('hooks have valid trigger types and action types', () => {
        for (const hook of hooks) {
          const spec = parseSpec(hook)
          expect(spec.triggerType).toBeTruthy()
          expect(spec.triggerFilter).toBeDefined()
          expect(spec.actionType).toBeTruthy()
          expect(['run_shell_command', 'send_notification']).toContain(spec.actionType)
          expect(spec.actionConfig).toBeDefined()
        }
      })

      it('hook names match expected list', () => {
        const names = hooks.map(h => h.name).sort()
        expect(names).toEqual([
          'argocd_sync_degraded',
          'diagnose_pod_crashloop',
          'disk_full_warning',
          'notify_oom_kill',
          'tool_usage_audit',
        ])
      })

      it('hooks with send_notification have channel in actionConfig', () => {
        const notificationHooks = hooks.filter(n => {
          const spec = parseSpec(n)
          return spec.actionType === 'send_notification'
        })
        for (const hook of notificationHooks) {
          const spec = parseSpec(hook)
          expect(spec.actionConfig.channel).toBeTruthy()
          expect(spec.actionConfig.message).toBeTruthy()
        }
      })

      it('hooks with run_shell_command have command in actionConfig', () => {
        const shellHooks = hooks.filter(n => {
          const spec = parseSpec(n)
          return spec.actionType === 'run_shell_command'
        })
        for (const hook of shellHooks) {
          const spec = parseSpec(hook)
          expect(spec.actionConfig.command).toBeTruthy()
        }
      })
    })
  })

  describe('Rulesets', () => {
    it('exports exactly 4 rulesets', () => {
      expect(DEFAULT_RULESETS).toHaveLength(4)
    })

    it('all rulesets have required fields', () => {
      for (const ruleset of DEFAULT_RULESETS) {
        expect(ruleset.name).toBeTruthy()
        expect(ruleset.description).toBeTruthy()
        expect(() => JSON.parse(ruleset.criteria)).not.toThrow()
        expect(() => JSON.parse(ruleset.triggers)).not.toThrow()
      }
    })

    it('criteria entries have required fields', () => {
      for (const ruleset of DEFAULT_RULESETS) {
        const criteria = JSON.parse(ruleset.criteria) as Array<Record<string, unknown>>
        for (const entry of criteria) {
          expect(entry.name).toBeTruthy()
          expect(entry.type).toBeTruthy()
          expect(entry.threshold).toBeDefined()
          expect(entry.weight).toBeDefined()
          expect(typeof entry.weight).toBe('number')
        }
      }
    })

    it('criteria weights sum close to 1.0 per ruleset', () => {
      for (const ruleset of DEFAULT_RULESETS) {
        const criteria = JSON.parse(ruleset.criteria) as Array<{ weight: number }>
        const total = criteria.reduce((sum, e) => sum + e.weight, 0)
        expect(total).toBeGreaterThan(0.9)
        expect(total).toBeLessThanOrEqual(1.0)
      }
    })

    it('ruleset names match expected list', () => {
      const names = DEFAULT_RULESETS.map(r => r.name).sort()
      expect(names).toEqual([
        'conversation-quality',
        'hook-failure',
        'skill-low-precision',
        'task-complete',
      ])
    })
  })
})
