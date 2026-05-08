import { redactSensitive } from '@/lib/redact'

export type HookEvent = 'pre' | 'post'

export interface HookContext {
  event: HookEvent
  toolName: string
  args: unknown
  result?: string        // only for 'post' hooks
  agentId?: string
  taskId?: string
  environmentId?: string
}

export interface HookDecision {
  action: 'allow' | 'block' | 'modify'
  reason?: string
  modifiedArgs?: unknown  // only if action === 'modify'
}

export type ToolHookFn = (ctx: HookContext) => Promise<HookDecision>

// Hook registry — built-in hooks registered at module load
const preHooks: ToolHookFn[] = []
const postHooks: ToolHookFn[] = []

export function registerPreHook(fn: ToolHookFn) { preHooks.push(fn) }
export function registerPostHook(fn: ToolHookFn) { postHooks.push(fn) }

export async function runPreHooks(ctx: HookContext): Promise<HookDecision> {
  for (const hook of preHooks) {
    const decision = await hook(ctx)
    if (decision.action !== 'allow') return decision
  }
  return { action: 'allow' }
}

export async function runPostHooks(ctx: HookContext): Promise<void> {
  for (const hook of postHooks) {
    try { await hook(ctx) } catch (e) { console.warn('[hook] post-hook error:', e) }
  }
}

// ─── Built-in Hooks ───────────────────────────────────────────────────────────

// 1. audit-log (post hook): Log every tool call + result summary
registerPostHook(async (ctx) => {
  console.log(JSON.stringify({
    hook: 'audit-log',
    ts: new Date().toISOString(),
    agent: ctx.agentId,
    task: ctx.taskId,
    tool: ctx.toolName,
    resultLen: ctx.result?.length ?? 0,
  }))
  return { action: 'allow' }
})

// 2. secret-redact (post hook): Strip secrets from tool results before storage
registerPostHook(async (ctx) => {
  if (ctx.result) {
    ctx.result = redactSensitive(ctx.result)
  }
  return { action: 'allow' }
})

// 3. destructive-gate (pre hook): Audit trail for destructive patterns
const DESTRUCTIVE_PATTERNS = [
  /kubectl.*delete/i,
  /helm.*uninstall/i,
  /rm\s+-rf/i,
  /talos.*reset/i,
]

registerPreHook(async (ctx) => {
  const argsStr = JSON.stringify(ctx.args ?? '')
  const isDestructive = DESTRUCTIVE_PATTERNS.some(p =>
    p.test(ctx.toolName) || p.test(argsStr)
  )
  if (isDestructive) {
    // Log and allow — the permission system in tool-permissions.ts handles blocking
    // This hook just adds an audit trail for destructive patterns
    console.warn(`[destructive-gate] Destructive pattern detected: ${ctx.toolName} by agent ${ctx.agentId}`)
  }
  return { action: 'allow' }
})

// 4. cost-tracker (post hook): Track token usage per agent+task
const agentCostMap = new Map<string, number>()
const COST_WARN_THRESHOLD = 500_000

registerPostHook(async (ctx) => {
  if (ctx.agentId && ctx.result) {
    const key = `${ctx.agentId}:${ctx.taskId}`
    const current = agentCostMap.get(key) ?? 0
    const updated = current + ctx.result.length
    agentCostMap.set(key, updated)
    if (updated > COST_WARN_THRESHOLD && current <= COST_WARN_THRESHOLD) {
      console.warn(`[cost-tracker] Agent ${ctx.agentId} task ${ctx.taskId} has consumed ${updated} chars of tool output`)
    }
  }
  return { action: 'allow' }
})
