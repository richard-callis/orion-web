export interface ToolCall { tool: string; input: string; output?: string }

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  toolCalls?: ToolCall[]
  streaming?: boolean
}

export interface AppModel { id: string; name: string; provider: string; builtIn: boolean; modelId: string; isDefault: boolean }

export interface Conversation {
  id: string
  title: string | null
  createdAt: string
  _count: { messages: number }
}

export interface PlanTarget { type: 'task' | 'feature' | 'epic'; id: string }
export interface AgentRef { id: string; name: string }
export interface ChatEnvironment { id: string; name: string; type: string; status: string }

export interface ConversationMetadata {
  initialContext?: string
  planTarget?: PlanTarget
  agentTarget?: AgentRef
  agentChat?: AgentRef
  agentDraft?: boolean
  ollamaModel?: string
}

/** Which special mode a conversation is in (at most one applies). */
export type ChatMode =
  | { kind: 'plain' }
  | { kind: 'plan'; target: PlanTarget }
  | { kind: 'agentChat'; agent: AgentRef }
  | { kind: 'agentTarget'; agent: AgentRef }
  | { kind: 'agentDraft' }

export function modeFromMetadata(meta: ConversationMetadata | undefined): ChatMode {
  if (meta?.planTarget)  return { kind: 'plan', target: meta.planTarget }
  if (meta?.agentChat)   return { kind: 'agentChat', agent: meta.agentChat }
  if (meta?.agentTarget) return { kind: 'agentTarget', agent: meta.agentTarget }
  if (meta?.agentDraft)  return { kind: 'agentDraft' }
  return { kind: 'plain' }
}

export const PROVIDER_CONFIG: Record<string, { label: string; activeClass: string; modelClass: string }> = {
  anthropic: { label: 'Claude',  activeClass: 'bg-blue-500/20 text-blue-400 border-blue-500/40',     modelClass: 'bg-blue-500/10 text-blue-300 border-blue-500/30' },
  ollama:    { label: 'Ollama',  activeClass: 'bg-orange-500/20 text-orange-400 border-orange-500/40', modelClass: 'bg-orange-500/10 text-orange-300 border-orange-500/30' },
  google:    { label: 'Gemini',  activeClass: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/40',       modelClass: 'bg-cyan-500/10 text-cyan-300 border-cyan-500/30' },
  openai:    { label: 'OpenAI',  activeClass: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40', modelClass: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30' },
  custom:    { label: 'Custom',  activeClass: 'bg-purple-500/20 text-purple-400 border-purple-500/40', modelClass: 'bg-purple-500/10 text-purple-300 border-purple-500/30' },
}
export const PROVIDER_ORDER = ['anthropic', 'google', 'ollama', 'openai', 'custom']
