interface SchemaProperty {
  type: string
  description?: string
  enum?: string[]
  items?: SchemaProperty | { type: string; properties?: Record<string, SchemaProperty>; required?: string[] }
  properties?: Record<string, SchemaProperty>
  required?: string[]
}

export interface ManagementToolDef {
  name: string
  description: string
  inputSchema: {
    type: string
    properties?: Record<string, SchemaProperty>
    required?: string[]
  }
}

export interface TaskRunContext {
  taskId: string
  taskTitle: string
  taskDescription: string | null
  taskPlan: string | null
  agentId: string
  agentName: string
  systemPrompt: string
  modelId: string   // e.g. "claude:claude-sonnet-4-6" | "ext:<cuid>" | "ollama:<model>"
  gateway: { url: string; token: string } | null
  environmentId?: string  // ID of the environment linked to this agent's gateway
  managementTools?: {
    definitions: ManagementToolDef[]
    execute: (name: string, argsRaw: string) => Promise<string>
  }
  nebula?: { environmentId: string; traceId: string }  // Nebula observability context
  /**
   * Checkpointed tool results from a previous run of this task.
   * Keyed by stepIndex (1-based, matching TaskCheckpoint.stepIndex).
   * When present, the runner skips re-executing matching tool calls and
   * injects the stored result instead, preventing duplicate side effects on retry.
   */
  checkpoints?: Map<number, { toolName: string; result: string }>
}

export type AgentEvent =
  | { type: 'text';        content: string }
  | { type: 'tool_call';   tool: string; args: string }
  | { type: 'tool_result'; tool: string; result: string }
  | { type: 'usage';       inputTokens: number; outputTokens: number }
  | { type: 'done' }
  | { type: 'error';       error: string }

export interface AgentRunner {
  run(ctx: TaskRunContext): AsyncGenerator<AgentEvent>
}

export interface GatewayTool {
  name: string
  description: string
  category?: string
  inputSchema: {
    type: string
    properties?: Record<string, SchemaProperty>
    required?: string[]
  }
}
