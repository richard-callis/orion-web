/**
 * Knowledge base tools: remember, search, load context, graph, write.
 *
 * Tool definitions only — registered (in the canonical order) by ./index.ts.
 */

import { z } from 'zod'
import { prisma } from '@/lib/db'
import { hybridSearch, ownerFilterWhere } from '@/lib/embeddings'
import { parseToolArgs } from './shared'
import type { ToolDefinition } from './registry'

const KnowledgeRememberArgs = z.object({
  key: z.string().nullish(),
  value: z.string().nullish(),
  context: z.string().nullish(),
})

export const knowledgeRememberTool: ToolDefinition = {
  name: 'knowledge_remember',
  description: 'Save an important fact, decision, or learned pattern to your persistent agent memory. It will be injected into your context on every future turn so you can recall it without tool calls. Use for: namespace locations, cluster quirks, decisions made, operator configurations, etc.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      key:     { type: 'string', description: 'Short descriptive title (e.g. "tailscale-operator-namespace", "cluster-quirk-no-gpu")' },
      value:   { type: 'string', description: 'The fact or insight to remember' },
      context: { type: 'string', description: 'Why this is important (optional)' },
    },
    required: ['key', 'value'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'both',
  category: 'knowledge',
  handler: async (args, ctx) => {
    const { key, value, context: ctx2 } = parseToolArgs(KnowledgeRememberArgs, args)
    if (!key?.trim())   return 'Error: key is required'
    if (!value?.trim()) return 'Error: value is required'

    // Prefer agent-scoped knowledge (surfaced on every turn via buildAgentLocalContext)
    if (ctx.agentId) {
      const content = ctx2 ? `${value.trim()}\n\nContext: ${ctx2}` : value.trim()
      await ctx.prisma.agentKnowledge.upsert({
        where:  { agentId_title: { agentId: ctx.agentId, title: key.trim() } },
        update: { content, updatedAt: new Date() },
        create: { agentId: ctx.agentId, title: key.trim(), content, type: 'note' },
      })
      return `Remembered: [${key.trim()}] ${value.trim()}`
    }

    // Fallback: room-scoped knowledge when no agentId (shouldn't happen in normal room chat)
    if (ctx.roomId) {
      const content = ctx2 ? `${value.trim()}\n\nContext: ${ctx2}` : value.trim()
      await ctx.prisma.roomKnowledge.upsert({
        where:  { roomId_title: { roomId: ctx.roomId, title: key.trim() } },
        update: { content, updatedAt: new Date() },
        create: { roomId: ctx.roomId, title: key.trim(), content, type: 'note' },
      })
      return `Remembered (room-scoped): [${key.trim()}] ${value.trim()}`
    }

    return 'Error: no agentId or roomId in context — cannot persist memory.'
  },
}

// ── knowledge_search ──────────────────────────────────────────────────────────

export const knowledgeSearchTool: ToolDefinition = {
  name: 'knowledge_search',
  description: 'Semantically search the knowledge base (notes, runbooks, wiki pages) for content relevant to a query. Returns notes ranked by similarity.',
  inputSchema: {
    type: 'object',
    properties: {
      query:          { type: 'string',  description: 'Natural language search query' },
      limit:          { type: 'number',  description: 'Max results to return (1-20, default 5)' },
      includeContent: { type: 'boolean', description: 'Whether to include full note content (default true)' },
    },
    required: ['query'],
  },
  tier: 'read',
  parallelSafe: true,
  availableIn: 'both',
  category: 'knowledge',
  handler: async (args, ctx) => {
    const { query, limit = 5, includeContent = true } =
      args as { query?: string; limit?: number; includeContent?: boolean }
    if (!query) return 'Error: query is required'

    // SOC2: mirror the notes API's ownership scoping. A tool call made on
    // behalf of a specific logged-in user (ctx.userId set) is restricted to
    // that user's own notes plus unowned/shared notes; an autonomous
    // agent-driven call (no specific human owner, ctx.userId unset) is
    // trusted/unscoped like the service/gateway path.
    const { hits } = await hybridSearch(query, Math.min(limit, 20), ctx.userId)
    if (!hits.length) return 'No relevant notes found for this query.'

    return JSON.stringify(
      hits.map((r) => ({
        title:        r.title,
        type:         r.type,
        folder:       r.folder,
        score:        parseFloat(r.score.toFixed(5)),
        vectorScore:  r.vectorScore != null ? parseFloat(r.vectorScore.toFixed(3)) : null,
        keywordScore: r.keywordScore != null ? parseFloat(r.keywordScore.toFixed(3)) : null,
        ...(includeContent && { content: r.content.slice(0, 2000) }),
      })),
      null, 2
    )
  },
}

// ── knowledge_load_context ────────────────────────────────────────────────────

export const knowledgeLoadContextTool: ToolDefinition = {
  name: 'knowledge_load_context',
  description: 'Progressively load additional relevant knowledge-base context mid-task. Only the top 3 most-relevant notes are injected up front to keep the initial prompt small — call this when you need MORE background on a specific sub-topic. Returns formatted, sanitized note content ready to reason over.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural language description of the context you need' },
      limit: { type: 'number', description: 'Max additional notes to load (1-10, default 5)' },
    },
    required: ['query'],
  },
  tier: 'read',
  parallelSafe: true,
  availableIn: 'both',
  category: 'knowledge',
  handler: async (args, ctx) => {
    const { query, limit = 5 } = args as { query?: string; limit?: number }
    if (!query) return 'Error: query is required'
    const { retrieveKnowledgeContext } = await import('@/lib/embeddings')
    // SOC2: same per-user note scoping as knowledge_search — see ownerFilterSql
    // in lib/embeddings.ts. ctx.userId is only set for calls made on behalf of
    // a specific logged-in user; agent-driven calls (MCP, room-agents) leave it
    // unset and stay trusted/unscoped by design.
    const block = await retrieveKnowledgeContext(query, Math.min(Math.max(limit, 1), 10), 0.2, undefined, ctx.userId)
    return block || 'No additional relevant notes found for this query.'
  },
}

// ── knowledge_graph ───────────────────────────────────────────────────────────

export const knowledgeGraphTool: ToolDefinition = {
  name: 'knowledge_graph',
  description: 'Get the full knowledge graph — all notes with their types, wikilink dependencies, and semantic connections. Use this to understand what documentation exists and how topics relate.',
  inputSchema: {
    type: 'object',
    properties: {
      threshold:      { type: 'number',  description: 'Minimum similarity score for semantic edges (0.0-1.0, default 0.5)' },
      includeContent: { type: 'boolean', description: 'Include a short content snippet per note (default false)' },
    },
  },
  tier: 'read',
  parallelSafe: true,
  availableIn: 'both',
  category: 'knowledge',
  handler: async (args, ctx) => {
    const { threshold = 0.5, includeContent = false } =
      args as { threshold?: number; includeContent?: boolean }

    // SOC2: same per-user note scoping as knowledge_search — see
    // ownerFilterWhere/ownerFilterSql in lib/embeddings.ts. ctx.userId is
    // only set for calls made on behalf of a specific logged-in user;
    // agent-driven calls (MCP, room-agents) leave it unset and stay
    // trusted/unscoped by design.
    const notes = await prisma.note.findMany({
      where: ownerFilterWhere(ctx.userId),
      select: { id: true, title: true, type: true, folder: true, content: true },
      orderBy: { title: 'asc' },
    })
    const noteIds = notes.map((n) => n.id)
    // Scope semantic edges to notes the caller can actually see on both
    // ends — otherwise an edge to/from an out-of-scope note would either
    // leak that note's id or waste the `take: 200` budget on edges the
    // caller can't use.
    const semanticEdges = noteIds.length
      ? await prisma.semanticConnection.findMany({
          where: { score: { gte: threshold }, sourceNoteId: { in: noteIds }, targetNoteId: { in: noteIds } },
          select: { sourceNoteId: true, targetNoteId: true, score: true },
          orderBy: { score: 'desc' },
          take: 200,
        })
      : []

    const noteByTitle = new Map(notes.map((n) => [n.title.toLowerCase(), n.title]))
    const wikilinkEdges: Array<{ from: string; to: string }> = []
    const wikilinkRegex = /\[\[([^\]|#]+)(?:[|#][^\]]+)?\]\]/g
    for (const note of notes) {
      for (const match of note.content.matchAll(wikilinkRegex)) {
        const target = match[1].trim()
        if (noteByTitle.has(target.toLowerCase()) && target.toLowerCase() !== note.title.toLowerCase()) {
          wikilinkEdges.push({ from: note.title, to: target })
        }
      }
    }

    const nodeLines = notes.map((n) => {
      const tag = n.type !== 'note' ? ` [${n.type}]` : ''
      const folder = n.folder ? ` (${n.folder})` : ''
      const snippet = includeContent ? `\n  ${n.content.slice(0, 200).replace(/\n/g, ' ')}` : ''
      return `- ${n.title}${tag}${folder}${snippet}`
    })

    const wikiLines = wikilinkEdges.map((e) => `  ${e.from} → ${e.to}`)
    const noteById = new Map(notes.map((n) => [n.id, n]))
    const semLines = semanticEdges
      .map((e) => {
        const src = noteById.get(e.sourceNoteId)?.title
        const tgt = noteById.get(e.targetNoteId)?.title
        return src && tgt ? `  ${src} ~${e.score.toFixed(2)}~ ${tgt}` : null
      })
      .filter(Boolean)

    return [
      `## Notes (${notes.length})\n${nodeLines.join('\n')}`,
      `\n## Wikilink Edges (${wikiLines.length})\n${wikiLines.join('\n') || '  none'}`,
      `\n## Semantic Edges (${semLines.length})\n${semLines.join('\n') || '  none'}`,
    ].join('\n')
  },
}

// ── knowledge_write ───────────────────────────────────────────────────────────

export const knowledgeWriteTool: ToolDefinition = {
  name: 'knowledge_write',
  description: `Write a lesson, pattern, or finding to the shared knowledge base. Automatically embedded into the vector index so all agents can find it via knowledge_search.

Use this after completing or investigating any task. Structure content for maximum searchability:

  ## Context
  [When does this apply? What task/domain/service?]

  ## Problem
  [What went wrong, or what needed to be done?]

  ## Root Cause
  [Why did it happen?]

  ## Solution
  [Exact steps, commands, or approach that worked]

  ## Rules for Next Time
  - [Specific do/don't rules derived from this experience]`,
  inputSchema: {
    type: 'object',
    properties: {
      title:   { type: 'string', description: 'Short searchable title — include service/domain name and the key lesson. E.g. "Tailscale: namespace must exist before operator deploy"' },
      content: { type: 'string', description: 'Structured lesson — use the Context/Problem/Root Cause/Solution/Rules format for best search retrieval' },
      folder:  { type: 'string', description: '"Success Patterns" | "Failure Patterns" | "Cluster Quirks" | "Tool Usage" | "Agent Lessons" (default: "Agent Lessons")' },
      tags:    { type: 'array', items: { type: 'string' }, description: 'Domain tags for filtering, e.g. ["tailscale", "networking", "kubernetes"]' },
    },
    required: ['title', 'content'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'both',
  category: 'knowledge',
  handler: async (args) => {
    const { title, content, folder = 'Agent Lessons', tags } =
      args as { title?: string; content?: string; folder?: string; tags?: string[] }

    if (!title?.trim()) return 'Error: title is required'
    if (!content?.trim()) return 'Error: content is required'

    const { embedNote } = await import('@/lib/embeddings')

    const existing = await prisma.note.findFirst({ where: { title: title.trim() } })

    let note: { id: string; title: string; content: string }
    if (existing) {
      note = await prisma.note.update({
        where: { id: existing.id },
        data: {
          content:   content.trim(),
          folder:    folder.trim(),
          tags:      tags ? tags : (existing.tags ?? undefined),
          updatedAt: new Date(),
        },
      })
    } else {
      note = await prisma.note.create({
        data: {
          title:   title.trim(),
          content: content.trim(),
          folder:  folder.trim(),
          type:    'note',
          tags:    tags ? tags as any : undefined,
        },
      })
    }

    // Embed immediately so the note is searchable via knowledge_search right away
    const embedded = await embedNote(note).catch(e => { console.error(`[tool-registry] embedNote failed for "${note.title}":`, e); return false })

    const action = existing ? 'updated' : 'written'
    return `Knowledge ${action}: "${note.title}" (id: ${note.id}, folder: ${folder}, embedded: ${embedded})`
  },
}
