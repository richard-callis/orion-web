export interface RulesetSeed {
  name: string
  description: string
  criteria: string  // JSON string
  triggers: string  // JSON string
}

export const DEFAULT_RULESETS: RulesetSeed[] = [
  {
    name: "task-complete",
    description: "Evaluate agent performance when a task completes.",
    criteria: JSON.stringify([
      { name: "tool_count", type: "tool_count", threshold: 20, weight: 0.15, inverted: true },
      { name: "safety", type: "safety_check", threshold: 100, weight: 0.3 },
      { name: "completeness", type: "completeness_check", threshold: 50, weight: 0.25 },
      { name: "response_quality", type: "response_quality", threshold: 60, weight: 0.3 },
    ]),
    triggers: JSON.stringify(["on_task_complete"]),
  },
  {
    name: "conversation-quality",
    description: "Evaluate agent performance at the end of a conversation.",
    criteria: JSON.stringify([
      { name: "response_length", type: "response_quality", threshold: 50, weight: 0.2 },
      { name: "tool_diversity", type: "tool_count", threshold: 5, weight: 0.15 },
      { name: "safety", type: "safety_check", threshold: 100, weight: 0.3 },
      { name: "user_satisfaction", type: "completeness_check", threshold: 60, weight: 0.35 },
    ]),
    triggers: JSON.stringify(["on_conversation_end"]),
  },
  {
    name: "hook-failure",
    description: "Evaluate when a hook action fails.",
    criteria: JSON.stringify([
      { name: "execution_time", type: "tool_count", threshold: 30000, weight: 0.4, inverted: true },
      { name: "error_type", type: "error_check", threshold: 0, weight: 0.6 },
    ]),
    triggers: JSON.stringify(["on_hook_failure"]),
  },
  {
    name: "skill-low-precision",
    description: "Periodic check for skills that fire too broadly without helping.",
    criteria: JSON.stringify([
      { name: "fire_rate", type: "tool_count", threshold: 5, weight: 0.3 },
      { name: "success_rate", type: "response_quality", threshold: 0.3, weight: 0.7 },
    ]),
    triggers: JSON.stringify(["periodic"]),
  },
]

export async function seedRulesets(prisma: any): Promise<void> {
  for (const ruleset of DEFAULT_RULESETS) {
    await prisma.ruleset.upsert({
      where: { name: ruleset.name },
      update: { description: ruleset.description, criteria: ruleset.criteria, triggers: ruleset.triggers },
      create: { ...ruleset },
    })
  }
}
