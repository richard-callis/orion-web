/**
 * Worker task runs on the shared engine: builds the task prompt and tool list,
 * supplies the task tool policy (checkpoint replay → argument validation →
 * permission check → dispatch) and maps loop events to AgentEvents.
 */
import type { AgentEvent, TaskRunContext, GatewayTool } from './types'
import { GatewayClient } from './gateway-client'
import { agentActor } from '../gateway-headers'
import { describeRunnerError } from './abort'
import { buildTaskPrompt } from './task-prompt'
import { validateToolCallArgs } from '@/lib/tool-args-validation'
import { checkToolPermission } from '@/lib/tool-permissions'
import { runToolLoop, withTrimmedHistory } from './engine/loop'
import type { ChatProvider, ToolCallRequest, ToolSpec } from './engine/types'

const MAX_TURNS = 20

// Read-only tools a task run may execute concurrently within one turn.
const PARALLEL_SAFE = new Set([
  'orion_list_agents', 'orion_list_tasks', 'orion_get_task_events',
  'orion_list_rooms', 'orion_cluster_health', 'orion_get_environment',
  'knowledge_search', 'knowledge_graph', 'knowledge_related', 'knowledge_backlinks',
])

/** Run one task tool call under the task policy. `step` is the call's 1-based position in the run. */
async function runTaskTool(
  ctx: TaskRunContext,
  gateway: GatewayClient | null,
  gatewaySchemas: ReadonlyMap<string, unknown>,
  call: ToolCallRequest,
  step: number,
): Promise<string> {
  // Replay a checkpointed step from a previous run instead of repeating its side effects.
  const checkpoint = ctx.checkpoints?.get(step)
  if (checkpoint && checkpoint.toolName === call.name) {
    return `[Replayed from checkpoint step ${step}]\n${checkpoint.result}`
  }

  let parsedArgs: unknown
  try { parsedArgs = JSON.parse(call.argsRaw || '{}') } catch { parsedArgs = {} }
  // Registry tools validate against the registry, gateway tools against the
  // schema their gateway published (previously every gateway tool was rejected
  // here as an "Unknown tool").
  const validation = validateToolCallArgs(call.name, parsedArgs, gatewaySchemas)
  if (!validation.valid) {
    return `Tool validation failed for ${call.name}: ${validation.errors.join(', ')}. Check the tool schema and retry with correct arguments.`
  }

  // Permission check — must pass before any tool execution. Gateway tools need
  // an active agent and an admin grant (see tool-permissions.ts).
  const permission = await checkToolPermission(call.name, ctx.agentId ?? null, ctx.environmentId ?? null, undefined, { taskId: ctx.taskId })
  if (!permission.allowed) {
    return `Permission denied for tool '${call.name}': ${permission.reason ?? 'Tool not permitted for this agent'}. Contact an admin to grant access.`
  }

  if (ctx.managementTools?.definitions.some(d => d.name === call.name)) {
    return ctx.managementTools.execute(call.name, call.argsRaw)
  }
  if (!gateway) return 'No gateway connected — cannot execute tools'
  try {
    return await gateway.executeTool(call.name, JSON.parse(call.argsRaw) as Record<string, unknown>, ctx.signal)
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Drive a task run on `provider`. `parallel` enables concurrent execution of
 * read-only tools within a turn (OpenAI-compatible runner).
 */
export async function* runTask(
  ctx: TaskRunContext,
  provider: ChatProvider,
  opts: { parallel: boolean },
): AsyncGenerator<AgentEvent> {
  let gatewayTools: GatewayTool[] = []
  let gateway: GatewayClient | null = null
  if (ctx.gateway) {
    gateway = new GatewayClient(ctx.gateway.url, ctx.gateway.token, agentActor(ctx.agentId))
    try {
      gatewayTools = await gateway.listTools(ctx.signal)
    } catch (err) {
      yield { type: 'text', content: `⚠ Could not reach gateway: ${err instanceof Error ? err.message : err}\nProceeding without tools.\n` }
    }
  }

  // Plan-only turns get no tools at all — the model can only describe what it would do.
  const tools: ToolSpec[] = ctx.planOnly ? [] : [
    ...(ctx.managementTools?.definitions ?? []).map(t => ({ name: t.name, description: t.description, parameters: t.inputSchema })),
    ...gatewayTools.map(t => ({ name: t.name, description: t.description, parameters: t.inputSchema })),
  ]

  const taskPrompt = await buildTaskPrompt(ctx)
  const gatewaySchemas = new Map<string, unknown>(gatewayTools.map(t => [t.name, t.inputSchema]))

  try {
    for await (const ev of runToolLoop({
      provider: withTrimmedHistory(provider),
      messages: [
        { role: 'system', content: ctx.systemPrompt },
        { role: 'user', content: taskPrompt },
      ],
      tools,
      maxTurns: MAX_TURNS,
      signal: ctx.signal,
      emitTextWithToolCalls: true,
      ...(opts.parallel && { parallelSafe: (name: string) => PARALLEL_SAFE.has(name) }),
      hooks: { runTool: (call, step) => runTaskTool(ctx, gateway, gatewaySchemas, call, step) },
    })) {
      switch (ev.type) {
        case 'text':        yield { type: 'text', content: ev.content }; break
        case 'tool_call':   yield { type: 'tool_call', tool: ev.tool, args: ev.args }; break
        case 'tool_result': yield { type: 'tool_result', tool: ev.tool, result: ev.result }; break
        case 'end':
          if (ev.reason === 'max_turns') yield { type: 'text', content: '\n⚠ Reached maximum turns limit.' }
          if (ev.usage.inputTokens > 0 || ev.usage.outputTokens > 0) {
            yield { type: 'usage', inputTokens: ev.usage.inputTokens, outputTokens: ev.usage.outputTokens }
          }
          break
      }
    }
    yield { type: 'done' }
  } catch (err) {
    yield { type: 'error', error: describeRunnerError(err) }
  }
}
