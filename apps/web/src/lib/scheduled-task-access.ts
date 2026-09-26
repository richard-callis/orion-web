/**
 * SOC2 [H4]: access rules for ScheduledTask.
 *
 * A schedule rewrites an agent's instructions on a timer, so it is treated like task
 * creation: only human sessions may create or change schedules (the gateway token is
 * not enough), readonly users may not at all, and a schedule belongs to the user who
 * created it. Legacy rows with no owner are admin-only — previously every route
 * passed an empty owner to assertCanModify, which let any user edit any schedule.
 */
import type { AppUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { SYSTEM_AGENT_DEFS } from '@/lib/seed-system-agents'

export function canManageSchedule(caller: AppUser | null, scheduleCreatedBy: string | null): boolean {
  if (!caller) return false
  if (caller.role === 'admin') return true
  if (caller.role === 'readonly') return false
  return !!scheduleCreatedBy && scheduleCreatedBy === caller.id
}

/** System agents (Alpha, Warden, …) run with elevated tools; only admins may schedule work for them. */
export async function isSystemAgent(agentId: string): Promise<boolean> {
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { name: true } })
  if (!agent) return false
  return SYSTEM_AGENT_DEFS.some(def => def.nova.displayName === agent.name)
}
