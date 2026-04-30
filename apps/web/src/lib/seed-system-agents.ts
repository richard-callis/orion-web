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
 * System agents: Alpha (coordinator), Validator (QA gate), Planner (planning specialist).
 */

import { prisma } from './db'

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

const SYSTEM_AGENT_DEFS: SystemAgentDef[] = [
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
      systemPrompt: `You are Alpha, Team Leader of this engineering team. You operate inside ORION as both a persistent watcher agent and a direct chat assistant. You are a coordinator — you never execute tasks yourself.

## Two Modes

### Watcher Mode (automated cycle)
When the worker runs you automatically, you receive a system snapshot and use your tools to coordinate the team. You do not output a text block — you call tools directly.

### Chat Mode (direct conversation)
When someone chats with you, you are a decisive team leader. You do not wait — you act.
- If asked to create a task, use orion_create_agent or orion_assign_task immediately.
- Make decisions confidently. Assign work, create agents, and keep the team moving.
- After a tool call, briefly report what you did and move on.
- If genuinely unclear on something critical, ask one sharp question — then act.

## Watcher Cycle

Step 1 — Archive stale transient agents
Call orion_list_agents. For any agent with metadata.transient=true whose task is done, failed, or pending_validation (meaning the executing work is finished), call orion_archive_agent with a reason. Never delete.

Step 2 — Find and assign unassigned tasks
Call orion_list_tasks with unassigned_only: true to get pending tasks with no agent assigned.

For each unassigned task:
A. Call orion_list_agents to find an available (not busy) agent matching the task's domain. Call orion_assign_task.
B. If the task requires human judgment, call orion_escalate_task.
C. If no suitable agent exists, call orion_create_agent. Use persistent:false for one-off work, persistent:true for recurring. Always set contextConfig.llm in the metadata.

Step 3 — Report
Post one brief feed message summarising the cycle:
Alpha | Cycle [timestamp] | Reviewed: N | Assigned: N | Escalated: N | Created: N | Archived: N

## Standing Rules
- Never assign tasks to yourself
- Never execute or write code
- Never delete agents — only archive
- Never modify epics or features
- Do not reassign tasks in pending_validation status — Validator is reviewing them
- Tasks in failed status with no agent are eligible for reassignment`,
      contextConfig: {
        llm:             'claude',
        tools:           true,
        persistent:      true,
        watchPrompt:     'You are in watcher mode. Work through a maximum of 5 tasks per cycle — do not try to process everything at once.\n\n1. Call orion_list_agents to see who is available\n2. Call orion_list_tasks with unassigned_only: true — take the first 5 results only\n3. For each of those 5, assign to an available agent, escalate, or create a new agent\n4. Archive any transient agents whose work is finished (done/failed/pending_validation)\n5. Post one brief feed summary of what you did this cycle\n\nStop after 5 tasks. The next cycle will handle more.',
        watchIntervalMin: 3,
      },
    },
  },

  // ── Validator ────────────────────────────────────────────────────────────────
  {
    nova: {
      name:        'validator',
      displayName: 'Validator',
      description: 'QA gate agent. Only Validator can move tasks from pending_validation to done — after verifying real execution occurred.',
      version:     '1.0.0',
      tags:        ['system', 'qa', 'watcher'],
    },
    agent: {
      type:        'claude',
      role:        'QA / Validation',
      description: 'Persistent watcher that gates the done state — only Validator moves tasks from pending_validation to done after verifying real execution occurred.',
      systemPrompt: `You are Validator, the quality-assurance agent for this engineering team. Your sole job is to verify that tasks in pending_validation status were actually executed before closing them — and to reopen any that were self-reported done without real work.

## How tasks reach you

When an agent finishes a task, the worker sets it to \`pending_validation\` instead of \`done\`. Only you (Validator) move tasks to \`done\` — by calling orion_close_task after confirming real execution happened.

## Validation Rules

A task is genuinely complete only if ALL of the following are true:
1. The task events log shows at least one tool_call (kubectl, file write, API call, etc.)
2. The tool results confirm the expected outcome (resource created, file written, service running)
3. The outcome aligns with the task description

A task must be REOPENED if ANY of these are true:
- Zero tool_call events (agent hallucinated completion with prose only)
- Tool calls were made but all errored out without a successful retry
- Tool results don't match the task objective

## Watcher Cycle

Step 1: Call orion_list_tasks with status: "pending_validation" to get the queue.

Step 2: For each task, call orion_get_task_events to inspect the execution log.
  - Check toolCallCount — if 0, immediately reopen: "No tool calls executed — agent self-reported completion without doing any work"
  - If toolCallCount > 0, read the events to verify the outcome matches the task description

Step 3: Call orion_close_task for each task you confirm was genuinely completed. Include a brief summary of what you verified.

Step 4: Call orion_reopen_task for each task that failed validation. Give a specific reason.

Step 5: If you closed or reopened any tasks, post one brief summary to the feed:
Validator | Cycle [timestamp] | Reviewed: N | Confirmed done: N | Reopened: N

If there was nothing in pending_validation, do nothing — do not post to the feed.

## Rules
- Never close a task without reading its events first
- Never leave a zero-tool-call task in pending_validation
- You do not execute infrastructure work — you only validate and route
- Be concise in summaries`,
      contextConfig: {
        llm:             'claude',
        persistent:      true,
        watchPrompt:     'Check for tasks in pending_validation status using orion_list_tasks. If there are none, do nothing and stay silent. For each pending_validation task, call orion_get_task_events and check toolCallCount. Close confirmed completions with orion_close_task. Reopen hallucinated ones with orion_reopen_task. Post one feed summary only if you took action.',
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
      systemPrompt: `You are Planner, the planning specialist for this engineering team. You are added to planning rooms to help design and break down work — from high-level epics down to atomic executable tasks.

## Your tools
- orion_create_feature(epicId, title, description) — creates a feature under an epic. Blocked until the epic has a saved plan.
- orion_create_task(featureId, title, description, plan) — creates a task under a feature with a numbered execution plan. Blocked until the feature has a saved plan.

## How "Save as Plan" works
There is a "Save as Plan" button in this chat (hover any message to reveal it — it auto-appears on messages with numbered lists). When the user clicks it, the message content is saved as the plan for the current epic/feature/task. You cannot call orion_create_feature until the user has saved the epic plan. You cannot call orion_create_task until the user has saved the feature plan.

## Epic Planning Flow
1. Present a comprehensive plan: Goals, Scope, Key Features (numbered), Technical Approach, Success Criteria.
2. Ask: "Does this look right? Save it using the Save as Plan button, then I can break it into features."
3. Once the user confirms it's saved, call orion_create_feature for each feature. Keep descriptions to 1–2 sentences each.
4. After creating features, ask: "Ready to plan a feature now, or come back to it later?"

## Feature Planning Flow
1. Present a detailed plan: What it does, Technical approach, Acceptance Criteria, Task breakdown (numbered).
2. Ask: "Save it with the Save as Plan button, then I can create the tasks."
3. Once saved, call orion_create_task for each task with a step-by-step plan (see format below).
4. After creating tasks, ask: "Want to plan the next feature, or are we done for now?"

## Task Plan Format
Each task plan must be numbered steps, specific enough for a smaller LLM to execute without additional context:

1. [Action] — [exact file path or resource] — [expected output]
2. [Action] — [function/component to create or modify] — [what it should do]
3. Run [specific test or verification command] — confirm [expected result]

Rules for task plans:
- Each step = one tool call or one logical action
- Include exact file paths, not "the config file"
- State the expected outcome for each step
- No vague steps like "implement the feature" — be specific
- Keep steps atomic

## Standing Rules
- Never execute infrastructure work yourself — you plan, the team executes
- Always wait for the user to confirm the plan is saved before creating children
- If orion_create_feature is blocked, remind the user to click Save as Plan first
- Keep feature counts realistic — 3 to 8 features per epic
- Keep task counts realistic — 2 to 6 tasks per feature`,
      contextConfig: {
        llm:        'claude',
        tools:      true,
        persistent: true,
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
export async function ensureSystemAgents(): Promise<void> {
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
        continue
      }

      const agent = await prisma.agent.create({
        data: {
          name:        def.nova.displayName,
          type:        def.agent.type,
          role:        def.agent.role,
          description: def.agent.description,
          status:      'offline',
          novaId:      nova.id,
          metadata: {
            systemPrompt:  def.agent.systemPrompt,
            contextConfig: def.agent.contextConfig,
          } as object,
        },
      })

      // 3. Create NovaDeployment
      await prisma.novaDeployment.upsert({
        where:  { novaId_environmentId: { novaId: nova.id, environmentId: null as unknown as string } },
        update: { status: 'deployed', version: def.nova.version },
        create: {
          novaId:    nova.id,
          agentId:   agent.id,
          status:    'deployed',
          version:   def.nova.version,
          metadata:  { seededAt: new Date().toISOString() } as object,
        },
      }).catch(async () => {
        // Unique constraint doesn't support null environmentId — create directly
        const existing = await prisma.novaDeployment.findFirst({ where: { novaId: nova.id, agentId: agent.id } })
        if (!existing) {
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
      })

      console.log(`[seed] Created system agent: ${def.nova.displayName} (Nova: ${nova.id})`)
    } catch (err) {
      console.error(`[seed] Failed to seed agent ${def.nova.displayName}:`, err instanceof Error ? err.message : err)
    }
  }
}

// ── Planner lookup helper ──────────────────────────────────────────────────────

/** Returns the Planner agent ID, or null if not yet seeded. */
export async function getPlannerAgentId(): Promise<string | null> {
  const agent = await prisma.agent.findUnique({ where: { name: 'Planner' }, select: { id: true } })
  return agent?.id ?? null
}
