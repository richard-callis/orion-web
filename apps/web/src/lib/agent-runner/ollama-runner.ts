import type { AgentRunner, AgentEvent, TaskRunContext, GatewayTool } from './types'
import { GatewayClient } from './gateway-client'
import { getPrompt, interpolate } from '@/lib/system-prompts'

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: Array<{ function: { name: string; arguments: string } }>
}

interface OllamaResponse {
  message: OllamaMessage
  done: boolean
}

/**
 * Ollama runner — full function-calling loop using Ollama's /api/chat.
 * Fetches tool definitions from the gateway and handles tool call / result turns.
 */
export const ollamaRunner: AgentRunner = {
  async *run(ctx: TaskRunContext): AsyncGenerator<AgentEvent> {
    // Resolve Ollama base URL and timeout
    const { baseUrl: ollamaBaseUrl, timeoutSecs } = await resolveOllamaConfig(ctx.modelId)
    const modelId = ctx.modelId.startsWith('ollama:') ? ctx.modelId.slice('ollama:'.length) : ctx.modelId

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

    const ollamaToolDefs = [
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

    const messages: OllamaMessage[] = [
      { role: 'system', content: ctx.systemPrompt },
      { role: 'user', content: taskPrompt },
    ]

    const MAX_TURNS = 20
    let turns = 0

    try {
      while (turns < MAX_TURNS) {
        turns++
        const res = await fetch(`${ollamaBaseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: modelId,
            messages,
            stream: false,
            ...(ollamaToolDefs.length > 0 && { tools: ollamaToolDefs }),
          }),
          signal: AbortSignal.timeout(timeoutSecs * 1000),
        })

        if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`)
        const data = await res.json() as OllamaResponse

        const assistantMsg = data.message
        messages.push(assistantMsg)

        // Handle tool calls
        if (assistantMsg.tool_calls?.length) {
          for (const toolCall of assistantMsg.tool_calls) {
            const fn = toolCall.function
            yield { type: 'tool_call', tool: fn.name, args: fn.arguments }

            let result: string
            const argsRaw = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments)
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

            yield { type: 'tool_result', tool: fn.name, result }
            messages.push({ role: 'tool', content: result })
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

async function resolveOllamaConfig(modelId: string): Promise<{ baseUrl: string; timeoutSecs: number }> {
  // Lazy import prisma to avoid circular deps at module load time
  const { prisma } = await import('../db')

  let model = null

  if (modelId.startsWith('ext:')) {
    const extId = modelId.slice('ext:'.length)
    model = await prisma.externalModel.findUnique({ where: { id: extId } })
  } else if (modelId.startsWith('ollama:')) {
    const name = modelId.slice('ollama:'.length)
    model = await prisma.externalModel.findFirst({
      where: { provider: 'ollama', modelId: name, enabled: true },
    })
  }

  if (!model) {
    model = await prisma.externalModel.findFirst({ where: { provider: 'ollama', enabled: true } })
  }

  if (!model?.baseUrl) throw new Error('No Ollama model configured — add one in Admin → Models')

  return { baseUrl: model.baseUrl, timeoutSecs: model.timeoutSecs ?? 120 }
}
