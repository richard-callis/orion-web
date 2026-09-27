import type { Agent } from '@/types/tasks'

export interface AgentForm {
  name: string
  modelId: string   // 'human' | 'claude:claude-sonnet-4-6' | 'gemini:*' | 'ext:<cuid>'
  role: string
  description: string
  systemPrompt: string
  persistent: boolean      // always-on watcher agent
  watchPrompt: string      // what to check/do on each watch cycle
  watchIntervalMin: number // how often to run (minutes)
  tools: boolean           // enable ORION tool calling (create tasks, agents, etc.)
}

export interface ModelOption { id: string; name: string; provider: string; builtIn: boolean }

export const DEFAULT_MODEL = 'claude:claude-sonnet-4-6'
export const emptyForm: AgentForm = {
  name: '', modelId: DEFAULT_MODEL, role: '', description: '', systemPrompt: '',
  persistent: false, watchPrompt: '', watchIntervalMin: 60, tools: false,
}

const ROLE_COLORS = [
  'bg-blue-500', 'bg-purple-500', 'bg-emerald-500', 'bg-orange-500',
  'bg-pink-500', 'bg-cyan-500', 'bg-yellow-500', 'bg-red-500',
]

export function agentColor(index: number) { return ROLE_COLORS[Math.max(0, index) % ROLE_COLORS.length] }

export function agentInitials(name: string) {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
}

export function isArchived(a: Agent) { return !!(a.metadata as Record<string, unknown> | null)?.archived }

export function modelIdToType(modelId: unknown): string {
  if (typeof modelId !== 'string') return 'custom'
  if (modelId === 'human')             return 'human'
  if (modelId.startsWith('claude:'))   return 'claude'
  if (modelId.startsWith('gemini:'))   return 'custom'
  if (modelId.startsWith('ollama:') || modelId.startsWith('ext:')) return 'ollama'
  return 'custom'
}

export function agentLlm(agent: Agent): string | undefined {
  const cfg = (agent.metadata as Record<string, unknown> | null)?.contextConfig as Record<string, unknown> | undefined
  return typeof cfg?.llm === 'string' ? cfg.llm : undefined
}

export function modelDisplayLabel(llm: unknown, models: Array<{ id: string; name: string }>): string {
  if (!llm || typeof llm !== 'string') return 'AI agent'
  const found = models.find(m => m.id === llm)
  if (found) return found.name
  if (llm.startsWith('claude:')) return `Claude · ${llm.slice('claude:'.length).replace('claude-', '').replace(/-\d{8}/, '')}`
  if (llm.startsWith('ollama:')) return `Ollama · ${llm.slice('ollama:'.length)}`
  if (llm.startsWith('gemini:')) return `Gemini · ${llm.slice('gemini:'.length)}`
  return llm
}

/** Edit-form values for an existing agent. */
export function formFromAgent(agent: Agent): AgentForm {
  const meta = agent.metadata as Record<string, unknown> | null
  const cfg = meta?.contextConfig as Record<string, string | boolean | number> | undefined
  return {
    name:             agent.name,
    modelId:          agentLlm(agent) ?? (agent.type !== 'human' ? DEFAULT_MODEL : 'human'),
    role:             agent.role ?? '',
    description:      agent.description ?? '',
    systemPrompt:     (meta?.systemPrompt as string) ?? '',
    persistent:       (cfg?.persistent as boolean) ?? false,
    watchPrompt:      (cfg?.watchPrompt as string) ?? '',
    watchIntervalMin: (cfg?.watchIntervalMin as number) ?? 60,
    tools:            (cfg?.tools as boolean) ?? false,
  }
}

/** Metadata for a (non-human) agent; `withWatcher` includes the persistent-watcher settings. */
function agentMetadata(form: AgentForm, withWatcher: boolean) {
  return {
    systemPrompt: form.systemPrompt || undefined,
    contextConfig: {
      llm: form.modelId,
      ...(withWatcher && form.persistent && {
        persistent: true,
        watchPrompt: form.watchPrompt,
        watchIntervalMin: form.watchIntervalMin,
      }),
      ...(form.tools && { tools: true }),
    },
  }
}

/** POST /api/agents body for the create form. */
export function createBody(form: AgentForm) {
  return {
    name: form.name,
    type: modelIdToType(form.modelId),
    role: form.role || null,
    description: form.description || null,
    metadata: form.modelId !== 'human' ? agentMetadata(form, false) : undefined,
  }
}

/** PUT /api/agents/:id patch for the edit form. */
export function editPatch(form: AgentForm): Partial<Agent> {
  return {
    name: form.name,
    type: modelIdToType(form.modelId),
    role: form.role || null,
    description: form.description || null,
    metadata: form.modelId !== 'human' ? agentMetadata(form, true) : null,
  }
}
