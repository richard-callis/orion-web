/**
 * Tool discovery meta-tools: list/describe tools and propose new gateway tools.
 *
 * Tool definitions only — registered (in the canonical order) by ./index.ts.
 */

import { getToolDefinition, getToolsByCategory, getAllCategories } from './registry'
import type { ToolDefinition, ToolCategory } from './registry'

// ── propose_tool ──────────────────────────────────────────────────────────────

export const proposeToolTool: ToolDefinition = {
  name: 'propose_tool',
  description: "Propose a new MCP tool for admin review. Use this when you need a capability that isn't in your current tool list. The admin will be notified to approve or reject the proposal.",
  inputSchema: {
    type: 'object',
    properties: {
      name:        { type: 'string', description: 'snake_case tool name' },
      description: { type: 'string', description: 'Clear one-sentence description of what the tool does' },
      inputSchema: { type: 'object', description: 'JSON Schema for the tool inputs (type: object, properties, required)' },
      execType:    { type: 'string', enum: ['shell', 'http', 'builtin'], description: 'How the tool is executed' },
      execConfig:  { type: 'object', description: 'Execution config: shell={command}, http={url,method}' },
      environment_id: { type: 'string', description: 'Environment to associate the tool with (optional — inferred from context if omitted)' },
    },
    required: ['name', 'description', 'inputSchema'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'both',
  category: 'tools',
  handler: async (args, ctx) => {
    const { name, description, inputSchema: schema, execType, execConfig, environment_id } =
      args as { name?: string; description?: string; inputSchema?: object; execType?: string; execConfig?: object; environment_id?: string }

    if (!name || !description || !schema) {
      return 'Error: propose_tool requires name, description, and inputSchema'
    }

    const envId = environment_id ?? ctx.environmentId
    if (!envId) return 'Error: no environment context — pass environment_id explicitly'

    const existing = await ctx.prisma.mcpTool.findFirst({ where: { environmentId: envId, name } })
    if (existing) return `Tool "${name}" already exists (status: ${existing.status}).`

    await ctx.prisma.mcpTool.create({
      data: {
        environmentId: envId,
        name,
        description,
        inputSchema: schema as object,
        execType: (execType as string) || 'shell',
        execConfig: execConfig as object | undefined,
        enabled: false,
        builtIn: false,
        status: 'pending',
        proposedBy: ctx.agentId,
        proposedAt: new Date(),
      },
    })

    return `Tool "${name}" proposed successfully. An admin will review and approve it from Administration → Environments → Approvals.`
  },
}

// ── Tool discovery meta-tools ────────────────────────────────────────────────

export const listToolsTool: ToolDefinition = {
  name: 'list_tools',
  description: 'List available tools by category. Call this to discover what you can actually do before attempting an operation. Pass a category to narrow the results. ORION categories: tasks, agents, rooms, features, gitops, knowledge, environment, secrets, tools. Gateway categories (when linked): cluster-ops, docker, talos, localhost, security, discovery. Omit category to list everything.',
  inputSchema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        description: 'Optional category filter. ORION: tasks, agents, rooms, features, gitops, knowledge, environment, secrets, tools. Gateway: cluster-ops, docker, talos, localhost, security, discovery. Omit to list all.',
      },
    },
  },
  tier: 'read',
  parallelSafe: true,
  availableIn: 'both',
  category: 'tools',
  handler: async (args, ctx) => {
    const { category } = (args as Record<string, unknown>) ?? {}

    // Fetch gateway tools if available
    const gatewayTools = ctx.gateway?.listTools ? await ctx.gateway.listTools().catch(() => []) : []
    const gatewayByCategory = new Map<string, string[]>()
    for (const t of gatewayTools) {
      const cat = t.category ?? 'general'
      if (!gatewayByCategory.has(cat)) gatewayByCategory.set(cat, [])
      gatewayByCategory.get(cat)!.push(t.name)
    }

    if (category && typeof category === 'string') {
      // Check ORION registry first
      const orionTools = getToolsByCategory(category as ToolCategory)
      // Then gateway
      const gwTools = gatewayByCategory.get(category) ?? []

      if (orionTools.length === 0 && gwTools.length === 0) {
        const allOrion = getAllCategories()
        const allGw = [...gatewayByCategory.keys()]
        return `No tools found for category "${category}". ORION categories: ${allOrion.join(', ')}${allGw.length ? `. Gateway categories: ${allGw.join(', ')}` : ''}`
      }

      const lines: string[] = [`Tools in category "${category}":`]
      if (orionTools.length > 0) lines.push(...orionTools.map(t => `  - ${t.name}`))
      if (gwTools.length > 0) lines.push(...gwTools.map(n => `  - ${n}`))
      lines.push('\nCall describe_tool(name) to get full details on any tool.')
      return lines.join('\n')
    }

    // No category — list all
    const lines: string[] = ['Available tool categories:\n', '## ORION tools']
    for (const cat of getAllCategories()) {
      const tools = getToolsByCategory(cat)
      lines.push(`${cat} (${tools.length}): ${tools.map(t => t.name).join(', ')}`)
    }
    if (gatewayByCategory.size > 0) {
      lines.push('\n## Gateway tools')
      for (const [cat, names] of gatewayByCategory) {
        lines.push(`${cat} (${names.length}): ${names.join(', ')}`)
      }
    }
    lines.push('\nCall list_tools(category) to filter, or describe_tool(name) for full details.')
    return lines.join('\n')
  },
}

export const describeToolTool: ToolDefinition = {
  name: 'describe_tool',
  description: 'Get the full description and input schema for a specific tool. Use this when list_tools gives you a tool name but you need to understand its parameters before calling it. If the tool is not found, this will also check registered Novas (custom tool bundles) and suggest next steps.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Exact tool name to describe, e.g. "orion_close_task"' },
    },
    required: ['name'],
  },
  tier: 'read',
  parallelSafe: true,
  availableIn: 'both',
  category: 'tools',
  handler: async (args, ctx) => {
    const { name } = (args as Record<string, unknown>) ?? {}
    if (!name || typeof name !== 'string') return 'Error: name is required'

    // 1. Check registered tools
    const tool = getToolDefinition(name)
    if (tool) {
      return JSON.stringify({
        name: tool.name,
        category: tool.category,
        tier: tool.tier,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }, null, 2)
    }

    // 2. Not found in registry — search Novas
    const novas = await ctx.prisma.nova.findMany({
      select: { id: true, name: true },
    })

    const novaMatch = novas.find(n =>
      n.name.toLowerCase().includes(name.toLowerCase()) ||
      name.toLowerCase().includes(n.name.toLowerCase())
    )

    if (novaMatch) {
      return [
        `Tool "${name}" is not a built-in tool, but the Nova "${novaMatch.name}" (id: ${novaMatch.id}) may provide this capability.`,
        `Novas are custom tool bundles installed per-environment.`,
        `Check if this Nova is installed in your target environment, or ask a human to install it.`,
      ].join('\n')
    }

    // 3. Nothing found — suggest options
    const categories = getAllCategories()
    return [
      `Tool "${name}" does not exist in the registry and no matching Nova was found.`,
      ``,
      `Options:`,
      `  1. You may have the wrong name — call list_tools(category) to see actual tool names.`,
      `     Available categories: ${categories.join(', ')}`,
      `  2. If a new tool is genuinely needed, call propose_tool with a name, description, and inputSchema.`,
      `  3. If this should be a Nova (a custom reusable tool bundle), inform a human to create one.`,
    ].join('\n')
  },
}
