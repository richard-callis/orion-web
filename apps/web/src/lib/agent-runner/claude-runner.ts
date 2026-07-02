import type { AgentRunner, AgentEvent, TaskRunContext } from './types'
import { getPrompt, interpolate } from '@/lib/system-prompts'
import { prisma } from '@/lib/db'
import { decryptStrict } from '@/lib/encryption'

const CLAUDE_URL = process.env.ORION_CLAUDE_URL ?? 'http://orion-claude:3100'

/**
 * Claude runner — routes claude:* model IDs through the orion-claude sidecar.
 *
 * The sidecar runs the Claude Code CLI with OAuth credentials (never a bare API key).
 * When agentId is provided, the sidecar writes a per-request .mcp.json so Claude
 * can call ORION tools natively via MCP — same tool access as any other agent.
 *
 * This runner never calls api.anthropic.com directly.
 */
export const claudeRunner: AgentRunner = {
  async *run(ctx: TaskRunContext): AsyncGenerator<AgentEvent> {
    // Strip "claude:" prefix to get the raw model name (e.g. claude-sonnet-4-6)
    const modelName = ctx.modelId.startsWith('claude:')
      ? ctx.modelId.slice('claude:'.length)
      : ctx.modelId

    const taskTemplate = await getPrompt('system.task-execution')
    const taskPrompt = interpolate(taskTemplate, {
      taskTitle:       ctx.taskTitle,
      taskDescription: ctx.taskDescription ? `Description: ${ctx.taskDescription}` : '',
      taskPlan:        ctx.taskPlan ? `\nImplementation plan:\n${ctx.taskPlan}` : '',
    })

    // Inject completed checkpoint steps into the prompt so the sidecar (Claude Code CLI)
    // doesn't re-execute tool calls that already succeeded in a prior run.
    let fullPrompt = taskPrompt
    if (ctx.checkpoints && ctx.checkpoints.size > 0) {
      const steps = Array.from(ctx.checkpoints.entries())
        .sort(([a], [b]) => a - b)
        .map(([step, cp]) => `Step ${step} [${cp.toolName}]: ${cp.result}`)
        .join('\n')
      fullPrompt += `\n\n---\nThe following tool steps were already completed in a previous run. Do not repeat them:\n${steps}\n---`
    }

    // Fetch per-agent MCP token so the sidecar can set it as x-mcp-token in
    // the MCP transport headers when writing the per-request .mcp.json config.
    let mcpTokenForSidecar: string | undefined
    if (ctx.agentId) {
      try {
        const agentRow = await prisma.agent.findUnique({
          where:  { id: ctx.agentId },
          select: { mcpToken: true },
        })
        if (agentRow?.mcpToken) {
          mcpTokenForSidecar = decryptStrict(agentRow.mcpToken, 'mcpToken')
        }
      } catch {
        // Non-fatal: sidecar will fall back to ORION_MCP_TOKEN if mcpToken omitted
      }
    }

    try {
      const res = await fetch(`${CLAUDE_URL}/run/collect`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt:       fullPrompt,
          systemPrompt: ctx.systemPrompt,
          model:        modelName,
          agentId:      ctx.agentId,
          maxTurns:     20,
          ...(ctx.nebula && { nebula: ctx.nebula }),
          ...(mcpTokenForSidecar && { mcpToken: mcpTokenForSidecar }),
        }),
        signal: AbortSignal.timeout(300_000),
      })

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        yield { type: 'error', error: `orion-claude sidecar returned HTTP ${res.status}: ${body}` }
        return
      }

      const data = await res.json() as {
        text?: string
        error?: string
        inputTokens?: number
        outputTokens?: number
        usage?: { inputTokens?: number; outputTokens?: number; input_tokens?: number; output_tokens?: number }
      }

      if (data.error) {
        yield { type: 'error', error: data.error }
        return
      }

      if (data.text) {
        yield { type: 'text', content: data.text }
      }

      // Emit token usage if the sidecar reported it (field names vary by sidecar version)
      const inputTokens  = data.inputTokens  ?? data.usage?.inputTokens  ?? data.usage?.input_tokens  ?? 0
      const outputTokens = data.outputTokens ?? data.usage?.outputTokens ?? data.usage?.output_tokens ?? 0
      if (inputTokens > 0 || outputTokens > 0) {
        yield { type: 'usage', inputTokens, outputTokens }
      }

      yield { type: 'done' }
    } catch (err) {
      yield { type: 'error', error: err instanceof Error ? err.message : String(err) }
    }
  },
}
