import type { AgentRunner, AgentEvent, TaskRunContext } from './types'
import { getPrompt, interpolate } from '@/lib/system-prompts'

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

    try {
      const res = await fetch(`${CLAUDE_URL}/run/collect`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt:       taskPrompt,
          systemPrompt: ctx.systemPrompt,
          model:        modelName,
          agentId:      ctx.agentId,
          maxTurns:     20,
        }),
        signal: AbortSignal.timeout(300_000),
      })

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        yield { type: 'error', error: `orion-claude sidecar returned HTTP ${res.status}: ${body}` }
        return
      }

      const data = await res.json() as { text?: string; error?: string }

      if (data.error) {
        yield { type: 'error', error: data.error }
        return
      }

      if (data.text) {
        yield { type: 'text', content: data.text }
      }

      yield { type: 'done' }
    } catch (err) {
      yield { type: 'error', error: err instanceof Error ? err.message : String(err) }
    }
  },
}
