/**
 * Tool-policy decisions for the REST tool API (/tools/execute), kept free of
 * Express and process state so they can be unit-tested.
 */

import type { McpToolConfig } from '../orion-client.js'

export type RestToolDecision<B> =
  | { kind: 'unavailable'; status: 503; error: string }
  | { kind: 'forbidden'; status: 403; error: string }
  | { kind: 'unknown'; status: 404; error: string }
  | { kind: 'builtin'; builtin: B }
  | { kind: 'custom'; tool: McpToolConfig }

/**
 * Decide how (or whether) a REST tool call may run.
 *
 * Fails closed: until the tool policy has been fetched from ORION at least
 * once, nothing runs (503). The old code inferred "not loaded yet" from an
 * empty tool list, so when ORION legitimately disabled every tool, every
 * built-in — shell_exec included — became callable.
 */
export function resolveRestTool<B>(
  name: string,
  state: { toolsLoaded: boolean; activeTools: McpToolConfig[]; registry: Record<string, B> },
): RestToolDecision<B> {
  if (!state.toolsLoaded) {
    return { kind: 'unavailable', status: 503, error: 'Tool policy not loaded from ORION yet — try again shortly' }
  }
  const tool = state.activeTools.find(t => t.name === name)
  const builtin = Object.prototype.hasOwnProperty.call(state.registry, name) ? state.registry[name] : undefined
  if (!tool) {
    return builtin
      ? { kind: 'forbidden', status: 403, error: `Tool '${name}' is not enabled by ORION tool policy` }
      : { kind: 'unknown', status: 404, error: `Unknown tool: ${name}` }
  }
  if (tool.builtIn) {
    return builtin
      ? { kind: 'builtin', builtin }
      : { kind: 'unknown', status: 404, error: `Built-in tool '${name}' is not available on this gateway` }
  }
  return { kind: 'custom', tool }
}
