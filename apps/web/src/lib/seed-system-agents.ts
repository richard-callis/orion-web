/**
 * System agent seeding — runs on startup via instrumentation.ts and on fresh install.
 *
 * Each system agent is:
 *   1. Upserted as a Nova record (source: 'bundled', category: 'Agent') so it
 *      appears in the Nebula catalog and can be browsed / re-imported.
 *   2. Imported as an Agent (create-only — never overwrites existing records so
 *      admin customisations to prompts and LLM are preserved across restarts).
 *   3. Tracked with a NovaDeployment record.
 *
 * System agents: Alpha (coordinator), Veritas (QA gate), Planner (planning specialist), Atlas (environment specialist), Pulse (cluster health watcher), Mentor (agent effectiveness reviewer).
 */

import { randomBytes } from 'crypto'
import { prisma } from './db'
import { ACCESS_ADMIN_GROUP_NAME } from './tool-registry'
import { encrypt } from './encryption'
import { promptText } from '@/prompts'

// ── Nova + Agent definitions ──────────────────────────────────────────────────

interface SystemAgentDef {
  nova: {
    name:        string
    displayName: string
    description: string
    version:     string
    tags:        string[]
  }
  agent: {
    type:        string
    role:        string
    description: string
    systemPrompt:  string
    contextConfig: Record<string, unknown>
  }
}

export const SYSTEM_AGENT_DEFS: SystemAgentDef[] = [
  // ── Alpha ────────────────────────────────────────────────────────────────────
  {
    nova: {
      name:        'alpha',
      displayName: 'Alpha',
      description: 'Team coordinator. Assigns tasks, creates agents, escalates blockers. Runs as a persistent watcher every 3 minutes.',
      version:     '1.0.0',
      tags:        ['system', 'coordinator', 'watcher'],
    },
    agent: {
      type:        'claude',
      role:        'Team Leader',
      description: 'Persistent watcher that coordinates the team — assigns tasks, creates agents, escalates blockers. Never executes work itself.',
      systemPrompt: promptText('agents/alpha.system'),
      contextConfig: {
        llm:             'claude',
        tools:           true,
        persistent:      true,
        watchPrompt:     promptText('agents/alpha.watch'),
        watchIntervalMin: 3,
      },
    },
  },

  // ── Veritas ───────────────────────────────────────────────────────────────────
  {
    nova: {
      name:        'veritas',
      displayName: 'Veritas',
      description: 'QA gate agent. Only Veritas can move tasks from pending_validation to done — after verifying real execution occurred.',
      version:     '1.0.0',
      tags:        ['system', 'qa', 'watcher'],
    },
    agent: {
      type:        'claude',
      role:        'QA / Validation',
      description: 'Persistent watcher that gates the done state — only Veritas moves tasks from pending_validation to done after verifying real execution occurred.',
      systemPrompt: promptText('agents/veritas.system'),
      contextConfig: {
        llm:             'claude',
        tools:           true,
        persistent:      true,
        watchPrompt:     promptText('agents/veritas.watch'),
        watchIntervalMin: 5,
      },
    },
  },

  // ── Planner ──────────────────────────────────────────────────────────────────
  {
    nova: {
      name:        'planner',
      displayName: 'Planner',
      description: 'Planning specialist. Auto-added to every planning room. Guides Epic → Feature → Task decomposition and produces numbered step-by-step task plans for smaller LLM execution.',
      version:     '1.0.0',
      tags:        ['system', 'planning', 'decomposition'],
    },
    agent: {
      type:        'claude',
      role:        'Planning Specialist',
      description: 'Auto-added to every planning room. Guides the team through Epic → Feature → Task decomposition, creates items on the board, and produces numbered step-by-step task plans for smaller LLM execution.',
      systemPrompt: promptText('agents/planner.system'),
      contextConfig: {
        llm:        'claude',
        tools:      true,
        persistent: true,
      },
    },
  },

  // ── Atlas ─────────────────────────────────────────────────────────────────────
  {
    nova: {
      name:        'atlas',
      displayName: 'Atlas',
      description: 'Cluster environment specialist. Auto-added to every planning room. Answers where software should be deployed, which namespace, storage class, ingress pattern, and what prerequisites are already present.',
      version:     '1.0.0',
      tags:        ['system', 'environment', 'infrastructure', 'planning'],
    },
    agent: {
      type:        'claude',
      role:        'Environment Specialist',
      description: 'Auto-added to every planning room. Designates target environments, namespaces, storage, and ingress patterns for deployment tasks. Enforces cluster conventions and prevents duplicate deployments.',
      systemPrompt: promptText('agents/atlas.system'),
      contextConfig: {
        llm:        'claude',
        tools:      true,
        persistent: true,
      },
    },
  },

  // ── Pulse ─────────────────────────────────────────────────────────────────────
  {
    nova: {
      name:        'pulse',
      displayName: 'Pulse',
      description: 'Cluster health watcher. Runs every 15 minutes to check all ingress reachability and SSL certificate validity. Creates unassigned tasks for any degraded services so Alpha can route them to the right specialist.',
      version:     '1.0.0',
      tags:        ['system', 'health', 'monitoring', 'ingress', 'ssl'],
    },
    agent: {
      type:        'claude',
      role:        'Cluster Health Watcher',
      description: 'Actively monitors all cluster ingresses — checks HTTP reachability and SSL certificate validity. Reports degraded services by creating unassigned tasks for Alpha to route.',
      systemPrompt: promptText('agents/pulse.system'),
      contextConfig: {
        tools:            true,
        persistent:       true,
        watchIntervalMin: 15,
        watchPrompt: promptText('agents/pulse.watch'),
      },
    },
  },

  // ── Mentor ────────────────────────────────────────────────────────────────────
  {
    nova: {
      name:        'mentor',
      displayName: 'Mentor',
      description: 'Agent effectiveness reviewer. Audits agents\' task history and system prompts, then surgically rewrites prompts for underperforming agents to fix the root cause.',
      version:     '1.0.0',
      tags:        ['system', 'meta', 'watcher', 'prompt-engineer'],
    },
    agent: {
      type:        'claude',
      role:        'Agent Effectiveness Reviewer',
      description: 'Persistent watcher that audits agent task history and effectiveness, then rewrites system prompts for underperforming agents to fix the root cause of failures.',
      systemPrompt: promptText('agents/mentor.system'),
      contextConfig: {
        llm:             'claude',
        tools:           true,
        persistent:      true,
        watchIntervalMin: 60,
        watchPrompt: promptText('agents/mentor.watch'),
      },
    },
  },

  // ── Dream ─────────────────────────────────────────────────────────────────────
  {
    nova: {
      name:        'dream',
      displayName: 'Dream',
      description: 'Memory consolidation subsystem. Runs extraction, synthesis, and pruning cycles against the knowledge base on fixed schedules. Never receives chat turns — exists so its LLM/embedding spend can be attributed to a budget-tracked agent.',
      version:     '1.0.0',
      tags:        ['system', 'memory', 'background'],
    },
    agent: {
      type:        'system',
      role:        'Memory Consolidation',
      description: 'Background subsystem that extracts, synthesizes, and prunes knowledge-base notes from chat/task activity. Does not participate in chat rooms — exists solely as an attribution target for token-usage tracking.',
      systemPrompt: promptText('agents/dream.system'),
      contextConfig: {
        tools:      false,
        persistent: false,
      },
    },
  },

  // ── Warden ────────────────────────────────────────────────────────────────────
  {
    nova: {
      name:        'warden',
      displayName: 'Warden',
      description: 'Security incident triage agent. Monitors security rooms for new incidents, manages investigation cases, proposes and executes remediation actions per the tier approval matrix.',
      version:     '1.0.0',
      tags:        ['system', 'security', 'siem', 'triage'],
    },
    agent: {
      type:        'claude',
      role:        'Security Incident Responder',
      description: 'Persistent security agent that triages incidents, manages investigation cases, proposes remediation, and executes actions within its tier — from automated IP blocking to human-approved firewall rules.',
      systemPrompt: promptText('agents/warden.system'),
      contextConfig: {
        llm:        'claude',
        tools:      true,
        persistent: true,
        // Per SIEM_PLAN.md P4: tool whitelist for Warden = security_propose_action + SOC case management + orion_send_message
        // + security_propose_action (the single policy-gated write entry point).
        // All write actions route through action-service.decide() which enforces
        // the tier matrix, panic mode, and home-subnet overrides.
        //
        // Direct write tools (crowdsec_decision_create, etc.) are intentionally
        // excluded — Warden must go through security_propose_action.
        //
        // When `allowedTools` is present, room-agents.ts filters both gateway and
        // registry tools down to this list. Agents without `allowedTools` see the
        // full registry as before (backward compatible).
        allowedTools: [
          // Policy-gated write entry point (routes through action-service tier matrix)
          'security_propose_action',
          // SOC case management (all registered in tool-registry.ts for MCP access)
          'investigation_search',
          'investigation_create',
          'investigation_read',
          'investigation_note',
          'investigation_update',
          'investigation_link_incident',
          'observable_add',
          'observable_set_verdict',
          'timeline_add',
          // Warden SIEM management tools (incident-facing triage; see lib/siem/warden-management-tools.ts)
          'siem_get_incident',
          'siem_create_investigation',
          'siem_add_observable',
          'siem_add_note',
          'siem_update_incident_status',
          'siem_add_timeline_entry',
          // Phase 4 containment — request human approval, then poll status
          'siem_request_containment',
          'siem_check_containment_status',
          // Chat — orion_send_message is the real tool name (chat_post does not exist)
          'orion_send_message',
        ],
      },
    },
  },
]

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * Upsert system agents on startup.
 *
 * For each system agent:
 * 1. Upsert the Nova record (source: 'bundled') so it appears in the Nebula catalog.
 * 2. Create the Agent (create-only — skip if already exists to preserve customisations).
 * 3. Create a NovaDeployment linking the two.
 */

/**
 * Resolve the LLM to use for system agents.
 * Prefers the system-wide default model setting, falls back to the first
 * enabled ExternalModel, then to 'claude' as a last resort.
 */
async function resolveDefaultLlm(): Promise<string> {
  const setting = await prisma.systemSetting.findUnique({ where: { key: 'ai.default-model' } })
  if (setting?.value && typeof setting.value === 'string') return setting.value

  const first = await prisma.externalModel.findFirst({
    where: { enabled: true },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })
  if (first) return `ext:${first.id}`

  return 'claude'
}

export async function ensureSystemAgents(): Promise<void> {
  // Resolve the system default LLM once — used for all system agents so they
  // work out of the box without requiring manual LLM configuration.
  // Falls back to 'claude' only if no external model is configured at all.
  const defaultLlm = await resolveDefaultLlm()

  for (const def of SYSTEM_AGENT_DEFS) {
    try {
      // 1. Upsert Nova record
      const nova = await prisma.nova.upsert({
        where:  { name: def.nova.name },
        update: {
          displayName: def.nova.displayName,
          description: def.nova.description,
          version:     def.nova.version,
          tags:        def.nova.tags,
          // Update config so catalog always shows current defaults
          config: {
            name:          def.nova.name,
            displayName:   def.nova.displayName,
            description:   def.nova.description,
            type:          'agent',
            systemPrompt:  def.agent.systemPrompt,
            contextConfig: def.agent.contextConfig,
          } as object,
        },
        create: {
          name:        def.nova.name,
          displayName: def.nova.displayName,
          description: def.nova.description,
          category:    'Agent',
          version:     def.nova.version,
          source:      'bundled',
          tags:        def.nova.tags,
          config: {
            name:          def.nova.name,
            displayName:   def.nova.displayName,
            description:   def.nova.description,
            type:          'agent',
            systemPrompt:  def.agent.systemPrompt,
            contextConfig: def.agent.contextConfig,
          } as object,
        },
      })

      // 2. Create Agent (skip if exists — preserve admin customisations)
      const existing = await prisma.agent.findUnique({ where: { name: def.nova.displayName } })
      if (existing) {
        // Ensure Nova link is set if agent pre-dates Nebula
        if (!existing.novaId) {
          await prisma.agent.update({
            where: { id: existing.id },
            data:  { novaId: nova.id },
          })
        }
        // Ensure per-agent MCP token is set
        if (!existing.mcpToken) {
          const rawToken = randomBytes(32).toString('hex')
          await prisma.agent.update({
            where: { id: existing.id },
            data:  { mcpToken: encrypt(rawToken) },
          })
        }
        continue
      }

      const newMcpToken = randomBytes(32).toString('hex')
      const agent = await prisma.agent.create({
        data: {
          name:        def.nova.displayName,
          type:        def.agent.type,
          role:        def.agent.role,
          description: def.agent.description,
          status:      'online',
          novaId:      nova.id,
          mcpToken:    encrypt(newMcpToken),
          metadata: {
            systemPrompt:  def.agent.systemPrompt,
            contextConfig: { ...def.agent.contextConfig, llm: defaultLlm },
          } as object,
        },
      })

      // 3. Create or refresh the global (environment-less) NovaDeployment.
      // A compound-unique upsert can't match environmentId = NULL (Postgres
      // treats NULLs as distinct), so look the row up explicitly.
      const existingDeployment = await prisma.novaDeployment.findFirst({
        where: { novaId: nova.id, environmentId: null },
        select: { id: true },
      })
      if (existingDeployment) {
        await prisma.novaDeployment.update({
          where: { id: existingDeployment.id },
          data:  { agentId: agent.id, status: 'deployed', version: def.nova.version },
        })
      } else {
        await prisma.novaDeployment.create({
          data: {
            novaId:   nova.id,
            agentId:  agent.id,
            status:   'deployed',
            version:  def.nova.version,
            metadata: { seededAt: new Date().toISOString() } as object,
          },
        })
      }

      console.log(`[seed] Created system agent: ${def.nova.displayName} (Nova: ${nova.id})`)
    } catch (err) {
      console.error(`[seed] Failed to seed agent ${def.nova.displayName}:`, err instanceof Error ? err.message : err)
    }
  }

  // Seed agent system prompts into SystemPrompt table for Settings UI visibility.
  // Uses update: {} so existing admin edits are preserved on restart.
  for (const def of SYSTEM_AGENT_DEFS) {
    await prisma.systemPrompt.upsert({
      where:  { key: `agent.${def.nova.name}.system` },
      update: {},
      create: {
        key:         `agent.${def.nova.name}.system`,
        name:        `${def.nova.displayName} — System Prompt`,
        category:    'system',
        description: def.nova.description,
        content:     def.agent.systemPrompt,
      },
    }).catch(() => {})

    const watchPrompt = def.agent.contextConfig.watchPrompt
    if (typeof watchPrompt === 'string' && watchPrompt) {
      await prisma.systemPrompt.upsert({
        where:  { key: `agent.${def.nova.name}.watch` },
        update: {},
        create: {
          key:         `agent.${def.nova.name}.watch`,
          name:        `${def.nova.displayName} — Watch Prompt`,
          category:    'system',
          description: `Watch cycle prompt for ${def.nova.displayName}`,
          content:     watchPrompt,
        },
      }).catch(() => {})
    }
  }

  // Seed AgentProfile records for system agents (ring leader delegation)
  const PROFILE_DEFS: Array<{ agentName: string; domain: string; description: string; tags: string[] }> = [
    {
      agentName: 'Alpha',
      domain: 'system-coordinator',
      description: 'Team coordination, task assignment, escalation management, and workflow orchestration.',
      tags: ['task-assignment', 'escalation', 'workflow', 'coordination'],
    },
    {
      agentName: 'Veritas',
      domain: 'qa-validation',
      description: 'Testing, code review, deployment validation, and quality assurance gates.',
      tags: ['testing', 'code-review', 'deployment-validation', 'quality-assurance'],
    },
    {
      agentName: 'Planner',
      domain: 'planning',
      description: 'Architecture design, project planning, task breakdown, and milestone tracking.',
      tags: ['architecture', 'project-planning', 'task-breakdown', 'milestones'],
    },
    {
      agentName: 'Atlas',
      domain: 'environment-management',
      description: 'Environment management, connectors, bootstrap, and infrastructure provisioning.',
      tags: ['environments', 'connectors', 'bootstrap', 'infrastructure'],
    },
    {
      agentName: 'Pulse',
      domain: 'cluster-health',
      description: 'Cluster monitoring, ingress management, SSL certificates, and health checks.',
      tags: ['monitoring', 'ingress', 'ssl', 'health-checks'],
    },
    {
      agentName: 'Mentor',
      domain: 'agent-coaching',
      description: 'Prompt engineering, agent performance optimization, training, and coaching.',
      tags: ['prompt-improvement', 'agent-performance', 'training', 'coaching'],
    },
    {
      agentName: 'Warden',
      domain: 'security',
      description: 'Security incident triage, threat response, vulnerability assessment, and remediation execution.',
      tags: ['incident-response', 'threat-detection', 'security', 'triage'],
    },
  ]

  for (const pd of PROFILE_DEFS) {
    const agent = await prisma.agent.findUnique({ where: { name: pd.agentName }, select: { id: true } })
    if (!agent) continue

    await prisma.agentProfile.upsert({
      where: { agentId: agent.id },
      update: {},
      create: {
        agentId:     agent.id,
        domain:      pd.domain,
        description: pd.description,
        tags:        pd.tags,
        confidence:  0.5,
      },
    }).catch(() => {})

    console.log(`[seed] AgentProfile: ${pd.agentName} → ${pd.domain}`)
  }

  // Seed the "Access Admins" agent group and ensure Alpha is a member — without
  // this, requireAccessAdmin() in tool-registry.ts locks everyone (including
  // Alpha) out of manage_tool_group_access / manage_agent_group_membership,
  // since membership is what those tools gate on.
  const accessAdminGroup = await prisma.agentGroup.upsert({
    where:  { name: ACCESS_ADMIN_GROUP_NAME },
    update: {},
    create: {
      name:        ACCESS_ADMIN_GROUP_NAME,
      description: 'Agents allowed to grant/revoke tool-group access and agent-group membership. Coordinator-only — members must never call gateway execution tools themselves.',
    },
  }).catch(() => null)
  if (accessAdminGroup) {
    const alpha = await prisma.agent.findUnique({ where: { name: 'Alpha' }, select: { id: true } })
    if (alpha) {
      await prisma.agentGroupMember.upsert({
        where:  { agentGroupId_agentId: { agentGroupId: accessAdminGroup.id, agentId: alpha.id } },
        update: {},
        create: { agentGroupId: accessAdminGroup.id, agentId: alpha.id },
      }).catch(() => {})
      console.log(`[seed] Access Admins: ensured Alpha is a member`)
    }
  }

  // Backfill: ensure every agent in the DB has an mcpToken
  const agentsWithoutToken = await prisma.agent.findMany({
    where:  { mcpToken: null },
    select: { id: true },
  })
  for (const a of agentsWithoutToken) {
    const rawToken = randomBytes(32).toString('hex')
    await prisma.agent.update({
      where: { id: a.id },
      data:  { mcpToken: encrypt(rawToken) },
    }).catch(() => {})
  }
  if (agentsWithoutToken.length > 0) {
    console.log(`[seed] Backfilled mcpToken for ${agentsWithoutToken.length} agent(s)`)
  }
}

// ── Planner lookup helper ──────────────────────────────────────────────────────

/** Returns the Planner agent ID, or null if not yet seeded. */
export async function getPlannerAgentId(): Promise<string | null> {
  const agent = await prisma.agent.findUnique({ where: { name: 'Planner' }, select: { id: true } })
  return agent?.id ?? null
}

/** Returns the Atlas agent ID, or null if not yet seeded. */
export async function getEnvironmentSMEAgentId(): Promise<string | null> {
  const agent = await prisma.agent.findUnique({ where: { name: 'Atlas' }, select: { id: true } })
  return agent?.id ?? null
}
