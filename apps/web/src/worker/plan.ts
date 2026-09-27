export type PlanRisk = 'low' | 'medium' | 'high' | 'critical'

export interface ParsedPlan {
  summary: string | null
  riskLevel: PlanRisk | null
  estimatedDuration: string | null
  /** @deprecated prose fallback kept for backwards compat — prefer rollbackSteps */
  rollbackStrategy: string | null
  /** Execution steps from <steps> — used for partial plan approval UI. */
  steps: string[]
  /** How the agent will confirm the action worked (parsed from <verify_steps>). */
  verifySteps: string[]
  /** Concrete tool-call steps to undo the change (parsed from <rollback_steps>). */
  rollbackSteps: string[]
  raw: string
}

/**
 * Parse the structured <plan> block emitted by a plan-before-execute agent.
 * Returns null if no <plan> block is present yet (agent still streaming prose).
 */
export function parsePlan(text: string): ParsedPlan | null {
  const planMatch = text.match(/<plan>([\s\S]*?)<\/plan>/i)
  if (!planMatch) return null
  const body = planMatch[1]
  const tag = (name: string): string | null => {
    const m = body.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'))
    return m ? m[1].trim() : null
  }
  // Extract a list of <step> elements from a named container tag.
  const stepList = (containerName: string): string[] => {
    const container = body.match(new RegExp(`<${containerName}>([\\s\\S]*?)</${containerName}>`, 'i'))
    if (!container) return []
    return Array.from(container[1].matchAll(/<step>([\s\S]*?)<\/step>/gi))
      .map((m) => m[1].trim())
      .filter((s) => s.length > 0)
  }
  const rawRisk = tag('risk_level')?.toLowerCase() ?? null
  const riskLevel: PlanRisk | null =
    rawRisk === 'low' || rawRisk === 'medium' || rawRisk === 'high' || rawRisk === 'critical'
      ? rawRisk
      : null
  return {
    summary: tag('summary'),
    riskLevel,
    estimatedDuration: tag('estimated_duration'),
    rollbackStrategy: tag('rollback_strategy'),
    steps: stepList('steps'),
    verifySteps: stepList('verify_steps'),
    rollbackSteps: stepList('rollback_steps'),
    raw: planMatch[0],
  }
}

/** High/critical-risk plans must be approved by a human before tools run. */
export function planRequiresApproval(plan: ParsedPlan | null): boolean {
  return plan?.riskLevel === 'high' || plan?.riskLevel === 'critical'
}
