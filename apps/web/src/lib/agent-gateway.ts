import { prisma } from './db'
import { GatewayClient } from './agent-runner/gateway-client'
import type { GatewayTool } from './agent-runner/types'

export interface AgentGateway {
  url: string
  token: string
  client: GatewayClient
}

/**
 * Resolves the gateway for an agent based on its linked AgentEnvironment.
 * Returns null if the agent has no environment or the environment has no gateway.
 */
export async function resolveAgentGateway(agentId: string): Promise<AgentGateway | null> {
  const envLink = await prisma.agentEnvironment.findFirst({
    where: { agentId },
    include: { environment: { select: { gatewayUrl: true, gatewayToken: true } } },
  })
  const url   = envLink?.environment?.gatewayUrl
  const token = envLink?.environment?.gatewayToken
  if (!url || !token) return null
  return { url, token, client: new GatewayClient(url, token) }
}

/**
 * Fetches the tool definitions for an agent's linked gateway.
 * Returns empty array if no gateway is linked or gateway is unreachable.
 */
export async function resolveAgentGatewayTools(agentId: string): Promise<GatewayTool[]> {
  const gw = await resolveAgentGateway(agentId)
  if (!gw) return []
  try {
    return await gw.client.listTools()
  } catch {
    return []
  }
}
