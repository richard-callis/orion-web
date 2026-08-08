/**
 * Room ↔ Environment binding.
 *
 * Chat rooms are pinned to a single Environment so agents never guess
 * environment names in tool calls (historically a 90% gitops failure rate —
 * agents invented "production"/"homelab"/"k3s" because the valid list was
 * never in their prompt).
 *
 * Rules:
 *  - Exactly one environment registered → rooms auto-select it (create + lazy backfill).
 *  - Multiple environments, none selected → agents are directed to ask the user
 *    for the environment on their first reply, before any env-scoped action.
 */
import { prisma } from '@/lib/db'

export interface RoomEnvironment {
  id: string
  name: string
  type: string
}

const ENV_SELECT = { id: true, name: true, type: true } as const

/**
 * Resolve the environment for a room, auto-selecting and persisting it when the
 * room has none and exactly one environment exists. Returns null when the room
 * has no environment and none could be auto-selected.
 */
export async function resolveRoomEnvironment(
  roomId: string,
  currentEnvironmentId: string | null,
): Promise<RoomEnvironment | null> {
  if (currentEnvironmentId) {
    const env = await prisma.environment.findUnique({
      where: { id: currentEnvironmentId },
      select: ENV_SELECT,
    })
    if (env) return env
    // Stale pointer (environment deleted) — clear it and fall through to auto-select
    await prisma.chatRoom.update({ where: { id: roomId }, data: { environmentId: null } }).catch(() => {})
  }

  const envs = await prisma.environment.findMany({ select: ENV_SELECT, take: 2 })
  if (envs.length !== 1) return null

  await prisma.chatRoom.update({
    where: { id: roomId },
    data: { environmentId: envs[0].id },
  }).catch(() => {}) // room may have been deleted mid-flight — selection is best-effort
  return envs[0]
}

/**
 * Pick the environment for a new room: an explicitly requested id wins (validated),
 * otherwise auto-select when exactly one environment exists.
 */
export async function pickEnvironmentForNewRoom(
  requestedId: string | null,
): Promise<string | null> {
  if (requestedId) {
    const env = await prisma.environment.findUnique({ where: { id: requestedId }, select: { id: true } })
    return env?.id ?? null
  }
  const envs = await prisma.environment.findMany({ select: { id: true }, take: 2 })
  return envs.length === 1 ? envs[0].id : null
}

/**
 * Build the system-prompt block describing the room's environment binding.
 * Injected into every room agent's context (see room-agents.ts).
 */
export async function buildRoomEnvironmentBlock(env: RoomEnvironment | null): Promise<string> {
  if (env) {
    return [
      '## Room Environment',
      `This room is pinned to the environment "${env.name}" (id: ${env.id}, type: ${env.type}).`,
      `Every environment-scoped tool call (gitops proposals, kubectl, deployments, secrets) MUST target exactly this environment — pass "${env.name}" / its id verbatim. Never guess or invent another environment name.`,
    ].join('\n')
  }

  const envs = await prisma.environment.findMany({
    select: ENV_SELECT,
    orderBy: { name: 'asc' },
    take: 50,
  })
  if (envs.length === 0) {
    return [
      '## Room Environment',
      'No environments are registered in ORION yet. Environment-scoped tools (gitops, kubectl, deployments) will fail — tell the user an admin must add an environment first, and do not attempt env-scoped tool calls.',
    ].join('\n')
  }
  const roster = envs.map(e => `- "${e.name}" (id: ${e.id}, type: ${e.type})`).join('\n')
  return [
    '## Environment Selection Required',
    'This room has NO environment selected. The registered environments are:',
    roster,
    'Before performing ANY environment-scoped action (gitops proposals, kubectl, deployments, secrets), you MUST know which environment to use. If the user has not stated one, ask them in your FIRST reply which environment this room should target (they can also pin it with the selector at the top of the room). Never guess an environment name — only ever use a name/id from the list above.',
  ].join('\n')
}
