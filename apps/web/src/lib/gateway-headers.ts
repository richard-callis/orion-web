/**
 * Headers for ORION → gateway REST calls (`/tools/execute`, `/tools`).
 *
 * The gateway attributes tool calls (audit events, executor actorId) to the
 * `X-Orion-Actor-*` headers ORION sets — never to the request body, which is
 * caller-controlled. Every call should say who it is acting for.
 */
export type GatewayActorType = 'agent' | 'human'

export interface GatewayActor {
  id: string
  type: GatewayActorType
}

/** Actor for ORION-internal jobs and routes that act on the system's behalf. */
export const SYSTEM_ACTOR: GatewayActor = { id: 'orion-system', type: 'agent' }

export function humanActor(userId: string | null | undefined): GatewayActor {
  return userId ? { id: userId, type: 'human' } : SYSTEM_ACTOR
}

export function agentActor(agentId: string | null | undefined): GatewayActor {
  return agentId ? { id: agentId, type: 'agent' } : SYSTEM_ACTOR
}

export function gatewayHeaders(token: string, actor: GatewayActor = SYSTEM_ACTOR): Record<string, string> {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-Orion-Actor-Id': actor.id,
    'X-Orion-Actor-Type': actor.type,
  }
}
