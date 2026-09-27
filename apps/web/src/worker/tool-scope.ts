import { MANAGEMENT_TOOL_DEFS } from '@/lib/management-tools'

// ── Role-aware tool grouping ────────────────────────────────────────────────────
// Instead of injecting the full flat tool inventory on every task, detect the task
// type from its title/description and inject only the relevant groups plus core
// always-available tools. Falls back to the full inventory when no type matches.
const TOOL_GROUPS: Record<string, string[]> = {
  deployment:    ['gitops_propose', 'gitops_ls', 'gitea_merge_pr', 'validate_manifest', 'orion_cluster_health', 'get_deployment_template', 'list_deployment_templates'],
  investigation: ['knowledge_search', 'orion_get_environment', 'spawn_agent'],
  incident:      ['security_propose_action', 'observable_add', 'observable_set_verdict', 'investigation_create', 'investigation_update'],
  coordination:  ['orion_create_task', 'orion_assign_task', 'orion_escalate_task', 'orion_close_task', 'spawn_agent'],
  knowledge:     ['knowledge_remember', 'knowledge_search', 'knowledge_write', 'knowledge_graph', 'knowledge_load_context'],
}

// Tools that are always available regardless of detected task type.
const CORE_TOOLS = ['knowledge_search', 'knowledge_load_context', 'spawn_agent', 'orion_escalate_task']

// Keyword → group detection. First matching group(s) win; multiple can match.
const TASK_TYPE_KEYWORDS: Record<string, RegExp> = {
  deployment:    /\b(deploy|rollout|release|manifest|helm|gitops|image tag|argocd|sync)\b/i,
  incident:      /\b(incident|breach|alert|attack|intrusion|malware|cve|vulnerab|ban|firewall|observable|investigation)\b/i,
  investigation: /\b(investigate|diagnose|debug|root cause|why is|triage|inspect|analyze)\b/i,
  coordination:  /\b(assign|delegate|coordinate|schedule|create task|escalate|backlog|prioriti)\b/i,
  knowledge:     /\b(document|knowledge|runbook|wiki|note|remember|lesson)\b/i,
}

/**
 * Build the tool-inventory preamble lines for a task, scoped to the detected task
 * type(s). Returns the full inventory when nothing matches (preserves prior
 * behaviour). The flag indicates whether scoping was applied (so a hint about
 * knowledge_load_context can be added to the preamble).
 */
export function buildScopedToolList(
  taskText: string,
  gatewayAvailable: boolean,
): { lines: string; scoped: boolean } {
  const matched = Object.entries(TASK_TYPE_KEYWORDS)
    .filter(([, re]) => re.test(taskText))
    .map(([group]) => group)

  const gatewayLine = gatewayAvailable
    ? ['- (gateway tools available: kubectl_get, shell_exec, and others connected via environment gateway)']
    : []

  if (matched.length === 0) {
    // Fallback: full flat inventory (previous behaviour).
    return {
      lines: [
        ...managementToolLines(),
        ...gatewayLine,
      ].join('\n'),
      scoped: false,
    }
  }

  const allowed = new Set<string>([...CORE_TOOLS])
  for (const group of matched) for (const name of TOOL_GROUPS[group] ?? []) allowed.add(name)

  const lines = [
    ...MANAGEMENT_TOOL_DEFS
      .filter(t => allowed.has(t.name))
      .map(t => `- ${t.name}: ${t.description.split('\n')[0]}`),
    ...gatewayLine,
  ].join('\n')

  return { lines, scoped: true }
}

/** One `- name: first line of description` entry per management tool. */
export function managementToolLines(): string[] {
  return MANAGEMENT_TOOL_DEFS.map(t => `- ${t.name}: ${t.description.split('\n')[0]}`)
}
