import type { AgentRunner, AgentEvent, TaskRunContext, GatewayTool } from './types'
import { GatewayClient } from './gateway-client'
import { getPrompt, interpolate } from '@/lib/system-prompts'

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
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

/**
 * OpenAI runner — full function-calling loop using OpenAI's /v1/chat/completions.
 * Supports llama.cpp and other OpenAI-compatible providers.
 */
export const openaiRunner: AgentRunner = {
  async *run(ctx: TaskRunContext): AsyncGenerator<AgentEvent> {
    // Resolve OpenAI config
    const { baseUrl, apiKey, modelId, timeoutSecs } = await resolveOpenAIConfig(ctx.modelId)

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

    const openaiToolDefs = gatewayTools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }))

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
        const res = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {})
          },
          body: JSON.stringify({
            model: modelId,
            messages,
            stream: false,
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
          for (const toolCall of assistantMsg.tool_calls) {
            const fn = toolCall.function
            yield { type: 'tool_call', tool: fn.name, args: fn.arguments }

            let result: string
            if (gateway) {
              try {
                const args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments
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

async function resolveOpenAIConfig(modelId: string): Promise<{ baseUrl: string; apiKey: string | undefined; modelId: string; timeoutSecs: number }> {
  const { prisma } = await import('../db')
  let model = null

  if (modelId.startsWith('ext:')) {
    const extId = modelId.slice('ext:'.length)
    model = await prisma.externalModel.findUnique({ where: { id: extId } })
  }

  if (!model || model.provider !== 'openai') {
    throw new Error(`No OpenAI-compatible model configured for ID: ${modelId}`)
  }

  return {
    baseUrl: model.baseUrl,
    apiKey: model.apiKey || undefined,
    modelId: model.modelId,
    timeoutSecs: model.timeoutSecs ?? 120
  }
}
