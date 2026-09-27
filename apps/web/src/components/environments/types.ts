export interface McpTool {
  id: string
  environmentId: string
  name: string
  description: string
  inputSchema: Record<string, unknown>
  execType: string
  execConfig: Record<string, unknown> | null
  enabled: boolean
  builtIn: boolean
  status: string       // "active" | "pending" | "rejected"
  proposedBy: string | null
  proposedAt: string | null
}

export interface AgentEnv {
  id: string
  agentId: string
  agent: { id: string; name: string; type: string; role: string | null }
}

export interface Environment {
  id: string
  name: string
  type: string
  description: string | null
  gatewayUrl: string | null
  gatewayToken: string | null
  gatewayVersion: string | null
  // Credentials are never sent to the client — only whether each is set.
  hasGatewayToken?: boolean
  hasKubeconfig?: boolean
  hasFederationToken?: boolean
  hasTalosConfig?: boolean
  status: string
  lastSeen: string | null
  tools: McpTool[]
  agents: AgentEnv[]
  metadata?: Record<string, unknown> | null
  federationRole?: string | null
  spokeUrl?: string | null
  hubUrl?: string | null
}

export interface ToolGroup {
  id: string
  name: string
  description: string | null
  minimumTier: string
  environmentId: string
  tools: { toolId: string; tool: McpTool }[]
  agentAccess: { agentGroupId: string; agentGroup: { id: string; name: string } }[]
}

export interface AllAgent { id: string; name: string; type: string; role: string | null }

export interface AllUser { id: string; username: string; email: string; name: string | null; role: string }

export interface UserTier {
  userId: string
  tier: string
  environmentId: string
  user: AllUser
}

export interface BootstrapLog { type: 'step' | 'log' | 'error' | 'done'; message: string }

export interface JoinResult { token: string; expiresAt: string; dockerCmd: string; kubectlCmd: string }

export type EnvTab = 'tools' | 'agents' | 'groups' | 'access'

export const STATUS_DOT: Record<string, string> = {
  connected:    'bg-status-healthy',
  disconnected: 'bg-text-muted',
  error:        'bg-status-error',
}

export const EXEC_TYPE_LABELS: Record<string, string> = {
  builtin: 'Built-in',
  shell:   'Shell',
  http:    'HTTP',
}

export const TIERS = ['viewer', 'operator', 'admin'] as const
