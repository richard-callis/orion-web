/**
 * Discovery tool tests
 * Tests the find_specialist scoring algorithm.
 */

import { describe, it, expect } from 'vitest'

function scoreProfile(
  query: string,
  profile: { domain: string; description: string; tags: unknown[]; confidence: number },
): number {
  const q = query.toLowerCase()

  let domainScore = 0
  const domainLower = profile.domain.toLowerCase()
  if (q.includes(domainLower)) domainScore = 0.8
  else if (domainLower.includes(q)) domainScore = 0.5
  else {
    const qWords = q.split(/\s+/).filter(w => w.length > 2)
    const domainWords = domainLower.split(/[-_\s]+/).filter(w => w.length > 2)
    const matching = qWords.filter(w => domainWords.some(dw => dw.includes(w) || w.includes(dw))).length
    if (qWords.length > 0) domainScore = (matching / qWords.length) * 0.5
  }

  const tags = Array.isArray(profile.tags) ? (profile.tags as string[]).map(t => t.toLowerCase()) : []
  const qWords = q.split(/\s+/).filter(w => w.length > 2)
  let tagScore = 0
  if (qWords.length > 0 && tags.length > 0) {
    const matching = qWords.filter(w => tags.some(t => t.includes(w) || w.includes(t))).length
    tagScore = (matching / qWords.length) * 0.3
  }

  const profileConfidence = (profile.confidence ?? 0.5) * 0.2

  return Math.min(domainScore + tagScore + profileConfidence, 1.0)
}

describe('find_specialist scoring', () => {
  const makeProfile = (overrides: Partial<{ domain: string; description: string; tags: unknown[]; confidence: number }>) => ({
    domain: 'general',
    description: '',
    tags: [],
    confidence: 0.5,
    ...overrides,
  })

  it('gives high score for exact domain match', () => {
    const s = scoreProfile('kubernetes-sre', makeProfile({ domain: 'kubernetes-sre' }))
    expect(s).toBeGreaterThan(0.8)
  })

  it('gives strong score for substring domain match', () => {
    const s = scoreProfile('kubernetes', makeProfile({ domain: 'kubernetes-sre' }))
    expect(s).toBeGreaterThan(0.5)
  })

  it('gives partial score for keyword overlap in domain', () => {
    const s = scoreProfile('pod debugging restart', makeProfile({ domain: 'pod-debugging' }))
    // "pod" matches "pod-debugging", "debugging" matches "pod-debugging", "restart" doesn't
    expect(s).toBeGreaterThan(0.1)
  })

  it('gives bonus score for tag matching', () => {
    const s = scoreProfile('testing code review', makeProfile({
      tags: ['testing', 'code-review', 'deployment'],
      confidence: 1.0,
    }))
    expect(s).toBeGreaterThan(0.5) // confidence alone gives 0.2 + tags give additional
  })

  it('weights confidence from profile', () => {
    const sHigh = scoreProfile('kubernetes-sre', makeProfile({ domain: 'kubernetes-sre', confidence: 1.0 }))
    const sLow = scoreProfile('kubernetes-sre', makeProfile({ domain: 'kubernetes-sre', confidence: 0.3 }))
    expect(sHigh).toBeGreaterThan(sLow)
  })

  it('returns score capped at 1.0', () => {
    const s = scoreProfile('kubernetes-sre', makeProfile({
      domain: 'kubernetes-sre',
      tags: ['kubernetes', 'sre'],
      confidence: 1.0,
    }))
    expect(s).toBeLessThanOrEqual(1.0)
  })

  it('returns low score for unrelated query', () => {
    const s = scoreProfile('database migration postgres', makeProfile({
      domain: 'kubernetes-sre',
      tags: ['pod-debugging', 'node-management'],
      confidence: 0.5,
    }))
    expect(s).toBeLessThan(0.3)
  })

  it('ranks correct agent first in a multi-agent list', () => {
    const agents = [
      scoreProfile('fix pod crash loop', makeProfile({
        domain: 'kubernetes-sre',
        tags: ['pod-debugging', 'crash-loop'],
        confidence: 0.8,
      })),
      scoreProfile('fix pod crash loop', makeProfile({
        domain: 'qa-validation',
        tags: ['testing', 'code-review'],
        confidence: 0.9,
      })),
      scoreProfile('fix pod crash loop', makeProfile({
        domain: 'pod-debugging',
        tags: ['pod-debugging', 'crash-loop', 'restart'],
        confidence: 0.95,
      })),
    ]

    // The third profile (pod-debugging) should score highest
    expect(agents[2]).toBeGreaterThanOrEqual(agents[0])
    expect(agents[2]).toBeGreaterThanOrEqual(agents[1])
  })
})
