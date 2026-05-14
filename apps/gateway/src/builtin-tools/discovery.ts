/**
 * Discovery MCP tools for the ORION mission control gateway.
 *
 * These tools let the ring leader discover specialist agents for delegation:
 * - find_specialist: Search AgentProfile by domain, tags, and confidence
 *
 * The gateway calls ORION's web API at the configured ORION_URL
 * (defaults to http://localhost:3000 if not set).
 */

const ORION_URL = process.env.ORION_URL ?? 'http://localhost:3000'
const ORION_TOKEN = process.env.ORION_GATEWAY_TOKEN

/**
 * Fetch from ORION's API with basic error handling.
 */
async function orionFetch(path: string, options?: RequestInit): Promise<unknown> {
  const url = `${ORION_URL}${path}`
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }

  if (ORION_TOKEN) {
    headers['Authorization'] = `Bearer ${ORION_TOKEN}`
  }

  const res = await fetch(url, {
    ...options,
    headers: { ...headers, ...(options?.headers as Record<string, string> || {}) },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`ORION ${path} returned ${res.status}: ${body.slice(0, 200)}`)
  }
  return res.json()
}

/**
 * Score an agent profile against a query using keyword overlap + tag matching.
 * Returns a score between 0 and 1.
 */
function scoreProfile(query: string, profile: {
  domain: string
  description: string
  tags: unknown[]
  confidence: number
}): number {
  const q = query.toLowerCase()

  // Domain match (exact or substring)
  const domainLower = profile.domain.toLowerCase()
  let domainScore = 0
  if (q.includes(domainLower)) domainScore = 0.8
  else if (domainLower.includes(q)) domainScore = 0.5
  else {
    // Keyword overlap
    const qWords = q.split(/\s+/).filter(w => w.length > 2)
    const domainWords = domainLower.split(/[-_\s]+/).filter(w => w.length > 2)
    const matching = qWords.filter(w => domainWords.some(dw => dw.includes(w) || w.includes(dw))).length
    if (qWords.length > 0) domainScore = (matching / qWords.length) * 0.5
  }

  // Tag overlap
  const tags = Array.isArray(profile.tags) ? (profile.tags as string[]).map(t => t.toLowerCase()) : []
  const qWords = q.split(/\s+/).filter(w => w.length > 2)
  let tagScore = 0
  if (qWords.length > 0 && tags.length > 0) {
    const matching = qWords.filter(w => tags.some(t => t.includes(w) || w.includes(t))).length
    tagScore = (matching / qWords.length) * 0.3
  }

  // Confidence from profile
  const profileConfidence = (profile.confidence ?? 0.5) * 0.2

  return Math.min(domainScore + tagScore + profileConfidence, 1.0)
}

export const discoveryTools = [
  {
    name: 'find_specialist',
    description: 'Discover which specialist agent should handle a given task. ' +
      'Uses domain matching, tag-based fuzzy matching, and confidence scoring to ' +
      'find the best agents for a given query. Use this before calling delegate() ' +
      'when you are unsure which agent should handle a task.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Description of the task or problem. The ring leader fills this with the delegation objective.',
        },
        environment: {
          type: 'string',
          description: 'Optional environment name to filter by. If omitted, returns agents active everywhere.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results. Default 3, max 5.',
          default: 3,
        },
        minConfidence: {
          type: 'number',
          description: 'Minimum confidence threshold (0.0-1.0). Default 0.3.',
          default: 0.3,
        },
      },
      required: ['query'],
    },
    async execute(args: Record<string, unknown>) {
      const query = String(args.query)
      const env = String(args.environment ?? '')
      const limit = Math.min(Math.max(parseInt(String(args.limit ?? '3'), 10), 1), 5)
      const minConf = Math.min(Math.max(parseFloat(String(args.minConfidence ?? '0.3')), 0), 1)

      let profiles: Array<{
        id: string
        agentId: string
        domain: string
        description: string
        tags: unknown[]
        confidence: number
        verifiedAt: string | null
        agent: { name: string; status: string }
      }>

      try {
        // Query agent profiles directly; optionally filter by environment
        const qs = env ? `?environmentId=${encodeURIComponent(env)}` : ''
        const result = await orionFetch(`/api/agent-profiles${qs}`)
        profiles = result as typeof profiles
      } catch {
        // If the API endpoint doesn't exist yet, return a helpful message
        return `find_specialist: Unable to reach ORION API to fetch agent profiles. ` +
          `Ensure AgentProfile records exist and the ORION_URL is configured correctly. ` +
          `Agents are discovered via their AgentProfile records which store domain, tags, and confidence.`
      }

      if (!profiles || profiles.length === 0) {
        return 'No specialist agents found. AgentProfile records must be created for discoverable agents.'
      }

      // Score and sort
      const scored = profiles
        .map(p => ({
          ...p,
          score: scoreProfile(query, p),
        }))
        .filter(p => p.score > 0 && (p.confidence ?? 0) >= minConf)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)

      if (scored.length === 0) {
        return `No specialist agents matched the query "${query}" (minConfidence: ${minConf}). ` +
          `Try broadening your query or lowering the confidence threshold.`
      }

      const lines: string[] = [`Found ${scored.length} specialist agent(s) for: "${query}"`]
      lines.push('')

      for (let i = 0; i < scored.length; i++) {
        const p = scored[i]
        lines.push(`--- #${i + 1} [${p.domain}] ${p.agent.name} ---`)
        lines.push(`  agentId:      ${p.agentId}`)
        lines.push(`  confidence:   ${(p.confidence * 100).toFixed(0)}%`)
        lines.push(`  score:        ${(p.score * 100).toFixed(1)}%`)
        lines.push(`  status:       ${p.agent.status}`)
        lines.push(`  description:  ${p.description.slice(0, 200)}`)
        if (Array.isArray(p.tags) && p.tags.length > 0) {
          lines.push(`  tags:         ${(p.tags as string[]).join(', ')}`)
        }
        lines.push('')
      }

      return lines.join('\n')
    },
  },
]
