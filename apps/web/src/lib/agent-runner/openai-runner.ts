import type { AgentRunner, AgentEvent, TaskRunContext, GatewayTool } from './types'
import { GatewayClient } from './gateway-client'
import { getPrompt, interpolate } from '@/lib/system-prompts'
import { validateToolArgs } from '@/lib/tool-registry'
import { checkToolPermission } from '@/lib/tool-permissions'

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
}

interface OpenAIResponse {
  choices: Array<{
    message: {
      role: 'assistant'
      content?: string
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
    }
  }>
}

// ── Context window trimming ───────────────────────────────────────────────────

const MAX_HISTORY_MESSAGES = 40
const KEEP_FIRST_MESSAGES = 2
const KEEP_LAST_MESSAGES = 20

function trimConversationHistory(messages: OpenAIMessage[]): OpenAIMessage[] {
  if (messages.length <= MAX_HISTORY_MESSAGES) return messages
  const first = messages.slice(0, KEEP_FIRST_MESSAGES)
  const last = messages.slice(-KEEP_LAST_MESSAGES)
  const dropped = messages.length - KEEP_FIRST_MESSAGES - KEEP_LAST_MESSAGES
  const notice: OpenAIMessage = {
    role: 'system',
    content: `[${dropped} earlier messages trimmed to stay within context limits. Task is still in progress.]`,
  }
  return [...first, notice, ...last]
}

// ── Parallel-safe tool set ────────────────────────────────────────────────────

function isParallelSafe(toolName: string): boolean {
  const PARALLEL_SAFE = new Set([
    'orion_list_agents', 'orion_list_tasks', 'orion_get_task_events',
    'orion_list_rooms', 'orion_cluster_health', 'orion_get_environment',
    'knowledge_search', 'knowledge_graph', 'knowledge_related', 'knowledge_backlinks',
  ])
  return PARALLEL_SAFE.has(toolName)
}

/**
 * OpenAI runner — full function-calling loop using OpenAI's /v1/chat/completions.
 * Supports llama.cpp and other OpenAI-compatible providers.
 */
export const openaiRunner: AgentRunner = {
  async *run(ctx: TaskRunContext): AsyncGenerator<AgentEvent> {
    // Resolve OpenAI config
    const { baseUrl, apiKey, modelId, timeoutSecs, maxTokens } = await resolveOpenAIConfig(ctx.modelId)

    // Fetch tools from gateway (if connected)
    let gatewayTools: GatewayTool[] = []
    let gateway: GatewayClient | null = null
    if (ctx.gateway) {
      gateway = new GatewayClient(ctx.gateway.url, ctx.gateway.token)
      try {
        gatewayTools = await gateway.listTools()
      } catch (err) {
        yield { type: 'text', content: `⚠ Could not reach gateway: ${err instanceof Error ? err.message : err}\nProceeding without tools.\n` }
      }
    }

    const mgmtToolDefs = (ctx.managementTools?.definitions ?? []).map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }))

    const openaiToolDefs = [
      ...mgmtToolDefs,
      ...gatewayTools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      })),
    ]

    const taskTemplate = await getPrompt('system.task-execution')
    const taskPrompt = interpolate(taskTemplate, {
      taskTitle:       ctx.taskTitle,
      taskDescription: ctx.taskDescription ? `Description: ${ctx.taskDescription}` : '',
      taskPlan:        ctx.taskPlan ? `\nImplementation plan:\n${ctx.taskPlan}` : '',
    })

    const messages: OpenAIMessage[] = [
      { role: 'system', content: ctx.systemPrompt },
      { role: 'user', content: taskPrompt },
    ]

    const MAX_TURNS = 20
    let turns = 0

    try {
      while (turns < MAX_TURNS) {
        turns++
        const trimmedMessages = trimConversationHistory(messages)
        const res = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {})
          },
          body: JSON.stringify({
            model: modelId,
            messages: trimmedMessages,
            stream: false,
            ...(maxTokens !== null && { max_tokens: maxTokens }),
            ...(openaiToolDefs.length > 0 && { tools: openaiToolDefs }),
          }),
          signal: AbortSignal.timeout(timeoutSecs * 1000),
        })

        if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`)
        const data = await res.json() as OpenAIResponse
        const assistantMsg = data.choices[0].message

        messages.push({ ...assistantMsg, content: assistantMsg.content ?? '' })

        // Handle tool calls
        if (assistantMsg.tool_calls?.length) {
          const toolCalls = assistantMsg.tool_calls

          // Helper: execute a single tool call and return { toolCall, result }
          const executeToolCall = async (toolCall: typeof toolCalls[number]): Promise<{ toolCall: typeof toolCalls[number]; result: string }> => {
            const fn = toolCall.function
            const argsRaw = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments)

            // Validate arguments before executing
            let parsedArgs: unknown
            try { parsedArgs = JSON.parse(argsRaw || '{}') } catch { parsedArgs = {} }
            const validation = validateToolArgs(fn.name, parsedArgs)
            if (!validation.valid) {
              return { toolCall, result: `Tool validation failed for ${fn.name}: ${validation.errors.join(', ')}. Check the tool schema and retry with correct arguments.` }
            }

            // Permission check — must pass before any tool execution
            const permission = await checkToolPermission(
              fn.name,
              ctx.agentId ?? null,
              ctx.environmentId ?? null,
            )
            if (!permission.allowed) {
              return { toolCall, result: `Permission denied for tool '${fn.name}': ${permission.reason ?? 'Tool not permitted for this agent'}. Contact an admin to grant access.` }
            }

            let result: string
            if (ctx.managementTools && ctx.managementTools.definitions.some(d => d.name === fn.name)) {
              result = await ctx.managementTools.execute(fn.name, argsRaw)
            } else if (gateway) {
              try {
                const args = JSON.parse(argsRaw)
                result = await gateway.executeTool(fn.name, args)
              } catch (err) {
                result = `Error: ${err instanceof Error ? err.message : String(err)}`
              }
            } else {
              result = 'No gateway connected — cannot execute tools'
            }

            return { toolCall, result }
          }

          // Separate parallel-safe from sequential tools
          const parallelCalls = toolCalls.filter(tc => isParallelSafe(tc.function.name))
          const sequentialCalls = toolCalls.filter(tc => !isParallelSafe(tc.function.name))

          // Run parallel-safe tools concurrently
          const parallelResults = await Promise.all(parallelCalls.map(tc => executeToolCall(tc)))
          for (const { toolCall, result } of parallelResults) {
            yield { type: 'tool_call', tool: toolCall.function.name, args: toolCall.function.arguments }
            yield { type: 'tool_result', tool: toolCall.function.name, result }
            messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result })
          }

          // Run sequential tools one at a time
          for (const toolCall of sequentialCalls) {
            yield { type: 'tool_call', tool: toolCall.function.name, args: toolCall.function.arguments }
            const { result } = await executeToolCall(toolCall)
            yield { type: 'tool_result', tool: toolCall.function.name, result }
            messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result })
          }

          // Continue loop to get next assistant response
          continue
        }

        // No tool calls — final response
        if (assistantMsg.content) {
          yield { type: 'text', content: assistantMsg.content }
        }
        break
      }

      if (turns >= MAX_TURNS) {
        yield { type: 'text', content: '\n⚠ Reached maximum turns limit.' }
      }

      yield { type: 'done' }
    } catch (err) {
      yield { type: 'error', error: err instanceof Error ? err.message : String(err) }
    }
  },
}

async function resolveOpenAIConfig(modelId: string): Promise<{ baseUrl: string; apiKey: string | undefined; modelId: string; timeoutSecs: number; maxTokens: number | null }> {
  const { prisma } = await import('../db')
  let model = null

  if (modelId.startsWith('ext:')) {
    const extId = modelId.slice('ext:'.length)
    model = await prisma.externalModel.findUnique({ where: { id: extId } })
  }

  // ext:openai or ext:custom -> use configured endpoint
  if (model && (model.provider === 'openai' || model.provider === 'custom')) {
    return {
      baseUrl: model.baseUrl,
      apiKey: model.apiKey || undefined,
      modelId: model.modelId,
      timeoutSecs: model.timeoutSecs ?? 120,
      maxTokens: (model as any).maxTokens ?? null,
    }
  }

  // ext:anthropic -> use Anthropic's OpenAI-compatible endpoint
  if (model && model.provider === 'anthropic') {
    return {
      baseUrl: model.baseUrl,
      apiKey: model.apiKey || process.env.ANTHROPIC_API_KEY || undefined,
      modelId: model.modelId,
      timeoutSecs: model.timeoutSecs ?? 120,
      maxTokens: (model as any).maxTokens ?? null,
    }
  }

  // ollama:* -> use local Ollama endpoint
  if (modelId.startsWith('ollama:')) {
    const modelName = modelId.slice('ollama:'.length)
    return {
      baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
      apiKey: undefined,
      modelId: modelName,
      timeoutSecs: 120,
      maxTokens: 8192,
    }
  }

  // claude:* -> use Anthropic's OpenAI-compatible endpoint
  if (modelId.startsWith('claude:')) {
    const modelName = modelId.slice('claude:'.length)
    return {
      baseUrl: 'https://api.anthropic.com',
      apiKey: process.env.ANTHROPIC_API_KEY,
      modelId: modelName,
      timeoutSecs: 120,
      maxTokens: 8192,
    }
  }

  throw new Error(`No OpenAI-compatible model configured for ID: ${modelId}`)
}
