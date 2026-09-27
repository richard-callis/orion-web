import type { AgentRunner, AgentEvent, TaskRunContext } from './types'
import { prisma } from '@/lib/db'
import { decryptStrict } from '@/lib/encryption'
import { describeRunnerError } from './abort'
import { sidecarCollect } from './engine/providers/claude-sidecar'
import { buildTaskPrompt } from './task-prompt'

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
    const modelName = ctx.modelId.startsWith('claude:') ? ctx.modelId.slice('claude:'.length) : ctx.modelId

    // Inject completed checkpoint steps into the prompt so the sidecar (Claude Code CLI)
    // doesn't re-execute tool calls that already succeeded in a prior run.
    let fullPrompt = await buildTaskPrompt(ctx)
    if (ctx.checkpoints && ctx.checkpoints.size > 0) {
      const steps = Array.from(ctx.checkpoints.entries())
        .sort(([a], [b]) => a - b)
        .map(([step, cp]) => `Step ${step} [${cp.toolName}]: ${cp.result}`)
        .join('\n')
      fullPrompt += `\n\n---\nThe following tool steps were already completed in a previous run. Do not repeat them:\n${steps}\n---`
    }

    // Per-agent MCP token, so the sidecar can authenticate its MCP calls as this agent.
    let mcpToken: string | undefined
    if (ctx.agentId && !ctx.planOnly) {
      try {
        const agentRow = await prisma.agent.findUnique({ where: { id: ctx.agentId }, select: { mcpToken: true } })
        if (agentRow?.mcpToken) mcpToken = decryptStrict(agentRow.mcpToken, 'mcpToken')
      } catch {
        // Non-fatal: sidecar will fall back to ORION_MCP_TOKEN if mcpToken omitted
      }
    }

    try {
      const r = await sidecarCollect({
        system: ctx.systemPrompt,
        messages: [{ role: 'user', content: fullPrompt }],
        model: modelName,
        // Plan-only turns omit agentId so the sidecar writes no MCP config —
        // the model gets no ORION tools and a single turn to produce its plan.
        ...(ctx.planOnly ? { maxTurns: 1 } : { agentId: ctx.agentId, maxTurns: 20 }),
        ...(ctx.nebula && { nebula: ctx.nebula }),
        ...(mcpToken && { mcpToken }),
      }, { timeoutMs: 300_000, signal: ctx.signal })

      if (!r.ok) {
        yield {
          type: 'error',
          error: r.status !== undefined ? `orion-claude sidecar returned HTTP ${r.status}: ${r.error}` : r.error,
        }
        return
      }

      if (r.text) yield { type: 'text', content: r.text }
      const inputTokens = r.usage.inputTokens ?? 0
      const outputTokens = r.usage.outputTokens ?? 0
      if (inputTokens > 0 || outputTokens > 0) yield { type: 'usage', inputTokens, outputTokens }
      yield { type: 'done' }
    } catch (err) {
      yield { type: 'error', error: describeRunnerError(err) }
    }
  },
}
