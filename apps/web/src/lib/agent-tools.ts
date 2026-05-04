/**
 * ORION tool definitions and execution for room agents.
 *
 * Tools are passed as OpenAI function-call schemas to the LLM.
 * When the model calls a tool, executeTool() runs the corresponding
 * Prisma operation and returns a result string the model can act on.
 *
 * Available tools:
 *   create_task         — create a new task
 *   update_task         — update status/title/description of an existing task
 *   create_agent        — create a new agent and invite it to the current room
 */

import { prisma } from './db'

// ── Tool definitions (OpenAI function-call format) ────────────────────────────

export const ORION_TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'create_task',
      description: 'Create a new task in ORION. Use this when a user asks you to log, track, or create a task.',
      parameters: {
        type: 'object',
        properties: {
          title:       { type: 'string', description: 'Short task title' },
          description: { type: 'string', description: 'Detailed description of what needs to be done' },
          priority:    { type: 'string', enum: ['low', 'medium', 'high'], description: 'Task priority (default: medium)' },
          status:      { type: 'string', enum: ['pending', 'in_progress', 'done', 'blocked'], description: 'Initial status (default: pending)' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'update_task',
      description: 'Update an existing task. Use this to change status, title, or description.',
      parameters: {
        type: 'object',
        properties: {
          taskId:      { type: 'string', description: 'The ID of the task to update' },
          title:       { type: 'string', description: 'New title (optional)' },
          description: { type: 'string', description: 'New description (optional)' },
          status:      { type: 'string', enum: ['pending', 'in_progress', 'done', 'blocked'], description: 'New status (optional)' },
          priority:    { type: 'string', enum: ['low', 'medium', 'high'], description: 'New priority (optional)' },
        },
        required: ['taskId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_agent',
      description: 'Create a new AI agent and automatically invite it to the current chat room. Use this when asked to spin up, create, or add a new agent.',
      parameters: {
        type: 'object',
        properties: {
          name:        { type: 'string', description: 'Unique name for the agent' },
          role:        { type: 'string', description: 'Role or job title (e.g. "Creative Writer", "QA Engineer")' },
          systemPrompt:{ type: 'string', description: 'Full system prompt defining the agent\'s personality and behavior' },
          llm:         { type: 'string', description: 'LLM identifier to use. Leave blank to use the same model as you.' },
        },
        required: ['name', 'systemPrompt'],
      },
    },
  },
] as const

// ── Tool execution ────────────────────────────────────────────────────────────

type ToolArgs = Record<string, unknown>

export async function executeTool(
  toolName: string,
  args: ToolArgs,
  context: { roomId: string; callerAgentId: string; callerLlm: string },
): Promise<string> {
  try {
    switch (toolName) {
      case 'create_task': {
        const task = await prisma.task.create({
          data: {
            title:       String(args.title ?? 'Untitled Task'),
            description: args.description ? String(args.description) : undefined,
            priority:    String(args.priority ?? 'medium'),
            status:      String(args.status ?? 'pending'),
            createdBy:   context.callerAgentId,
            assignedAgent: context.callerAgentId,
          },
        })
        return `Task created: "${task.title}" (id: ${task.id}, status: ${task.status}, priority: ${task.priority})`
      }

      case 'update_task': {
        const taskId = String(args.taskId ?? '')
        if (!taskId) return 'Error: taskId is required'
        const existing = await prisma.task.findUnique({ where: { id: taskId } })
        if (!existing) return `Error: task ${taskId} not found`
        const updated = await prisma.task.update({
          where: { id: taskId },
          data: {
            title:       args.title       ? String(args.title)       : undefined,
            description: args.description ? String(args.description) : undefined,
            status:      args.status      ? String(args.status)      : undefined,
            priority:    args.priority    ? String(args.priority)    : undefined,
          },
        })
        return `Task updated: "${updated.title}" (id: ${updated.id}, status: ${updated.status})`
      }

      case 'create_agent': {
        const name = String(args.name ?? '').trim()
        if (!name) return 'Error: name is required'

        // Check for name collision
        const existing = await prisma.agent.findUnique({ where: { name } })
        if (existing) return `Error: an agent named "${name}" already exists (id: ${existing.id})`

        const llm = args.llm ? String(args.llm) : context.callerLlm

        const agent = await prisma.agent.create({
          data: {
            name,
            role:   args.role ? String(args.role) : undefined,
            type:   'custom',
            status: 'online',
            metadata: {
              systemPrompt: String(args.systemPrompt ?? ''),
              contextConfig: { llm },
            } as any,
          },
        })

        // Auto-invite to the current room
        await prisma.chatRoomMember.create({
          data: { roomId: context.roomId, agentId: agent.id, role: 'member' },
        })

        // Post a system message so participants see it arrive
        await prisma.chatMessage.create({
          data: {
            roomId: context.roomId,
            senderType: 'system',
            content: `${agent.name} has joined the room.`,
          },
        })

        return `Agent created and invited: "${agent.name}" (id: ${agent.id}, llm: ${llm})`
      }

      default:
        return `Error: unknown tool "${toolName}"`
    }
  } catch (e) {
    return `Error executing ${toolName}: ${e instanceof Error ? e.message : String(e)}`
  }
}

// ── System prompt addendum ────────────────────────────────────────────────────

export const TOOLS_SYSTEM_ADDENDUM = `

## Your Tools in This Chat Room

You have access to these ORION coordination tools. Use them — do not pretend to perform an action when you can call a tool instead.

- **create_task**: Log a new task on the board (title, description, priority, status)
- **update_task**: Update an existing task by ID (status, title, description, priority)
- **create_agent**: Create a new AI agent and invite it to this chat room (name, role, systemPrompt, llm)

## Scope — What You Can and Cannot Do Here

**You are in a chat room. You can only coordinate here.**

- ✅ Create tasks, update tasks, create agents
- ✅ Discuss plans, answer questions, designate environments
- ❌ You CANNOT run kubectl, helm, docker, or any infrastructure commands from chat
- ❌ You CANNOT deploy, apply manifests, or access the cluster directly from chat
- ❌ Do NOT claim to execute infrastructure work — you do not have those tools here

**If infrastructure work is needed**: use \`create_task\` to log it on the board. A task-running agent with full infrastructure tool access will pick it up and execute it.

When you use a tool, report the result back clearly (e.g. "Done — created task #abc123: 'Deploy Gitea ingress'").`
