import fs from 'fs'
import path from 'path'
import type { AgentRunner, AgentEvent, TaskRunContext } from './types'
import type { SDKAssistantMessage } from '@anthropic-ai/claude-code'
import { getPrompt, interpolate } from '@/lib/system-prompts'

/**
 * Claude runner — uses the Claude Code SDK query() with the agent's system prompt.
 * For cluster environments, the gateway's kubectl tools map directly to the
 * existing Bash(kubectl ...) allowed-tools pattern.
 */
export const claudeRunner: AgentRunner = {
  async *run(ctx: TaskRunContext): AsyncGenerator<AgentEvent> {
    const { query } = await import('@anthropic-ai/claude-code')

    // Ensure credentials are accessible (same pattern as claude.ts)
    if (process.env.CLAUDE_CREDENTIALS_PATH) {
      const srcCreds = path.join(process.env.CLAUDE_CREDENTIALS_PATH, '.claude', '.credentials.json')
      const claudeHome = '/tmp/claude-home'
      const destDir = path.join(claudeHome, '.claude')
      fs.mkdirSync(destDir, { recursive: true })
      try { fs.copyFileSync(srcCreds, path.join(destDir, '.credentials.json')) } catch { /* ignore */ }
      process.env.HOME = claudeHome
    }

    const modelId = ctx.modelId.startsWith('claude:') ? ctx.modelId.slice('claude:'.length) : undefined

    const taskTemplate = await getPrompt('system.task-execution')
    const prompt = interpolate(taskTemplate, {
      taskTitle:       ctx.taskTitle,
      taskDescription: ctx.taskDescription ? `Description: ${ctx.taskDescription}` : '',
      taskPlan:        ctx.taskPlan ? `\nImplementation plan:\n${ctx.taskPlan}` : '',
    })

    try {
      const response = query({
        prompt,
        options: {
          customSystemPrompt: ctx.systemPrompt,
          allowedTools: [
            'Bash(kubectl get:*)',
            'Bash(kubectl describe:*)',
            'Bash(kubectl logs:*)',
            'Bash(kubectl top:*)',
            'Bash(kubectl rollout:*)',
            'Bash(kubectl scale:*)',
          ],
          maxTurns: 20,
          ...(modelId && { model: modelId }),
        },
      })

      for await (const msg of response) {
        if (msg.type === 'assistant') {
          const assistantMsg = msg as SDKAssistantMessage
          for (const block of assistantMsg.message.content) {
            if (block.type === 'text') {
              yield { type: 'text', content: block.text }
            } else if (block.type === 'tool_use') {
              yield { type: 'tool_call', tool: block.name, args: JSON.stringify(block.input) }
            }
          }
        } else if (msg.type === 'user') {
          const userMsg = msg as { type: 'user'; message: { content: unknown[] } }
          for (const block of userMsg.message.content as Array<{ type: string; content?: unknown }>) {
            if (block.type === 'tool_result') {
              const result = Array.isArray(block.content)
                ? (block.content as Array<{ type: string; text?: string }>).map(c => c.text ?? '').join('')
                : String(block.content ?? '')
              yield { type: 'tool_result', tool: 'bash', result }
            }
          }
        }
      }

      yield { type: 'done' }
    } catch (err) {
      yield { type: 'error', error: err instanceof Error ? err.message : String(err) }
    }
  },
}
