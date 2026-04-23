/**
 * Knowledge graph MCP tools for the ORION mission control gateway.
 *
 * These tools let AI agents interact with ORION's knowledge base:
 * - knowledge_search: Semantic search over notes (vector similarity)
 * - knowledge_graph: Get full graph data (wikilinks + semantic edges)
 * - knowledge_related: Find semantically similar notes to a specific note
 * - knowledge_backlinks: Find notes that wikilink to a given note
 * - knowledge_embed_all: Trigger embedding generation for all notes
 *
 * The gateway calls ORION's web API at the configured ORION_URL
 * (defaults to http://localhost:3000 if not set).
 */

const ORION_URL = process.env.ORION_URL ?? 'http://localhost:3000'

/**
 * Fetch from ORION's API with basic error handling.
 */
async function orionFetch(path: string, options?: RequestInit): Promise<unknown> {
  const url = `${ORION_URL}${path}`
  const res = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`ORION ${path} returned ${res.status}: ${body.slice(0, 200)}`)
  }
  return res.json()
}

export const knowledgeGraphTools = [
  {
    name: 'knowledge_search',
    description: 'Semantically search the ORION knowledge base (notes, wikis, runbooks). ' +
      'Finds notes related by meaning, not just keywords. Use this when you need to find ' +
      'relevant documentation — especially for questions that may not contain exact keywords.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language search query, e.g. "how to fix pod restart loops"',
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default 5, max 20)',
          default: 5,
        },
        includeContent: {
          type: 'boolean',
          description: 'Include full note content in results (default true)',
          default: true,
        },
      },
      required: ['query'],
    },
    async execute(args: Record<string, unknown>) {
      const limit = Math.min(Math.max(parseInt(String(args.limit ?? 5), 10), 1), 20)
      const body = {
        query: args.query as string,
        limit,
        includeContent: args.includeContent !== false,
      }

      const result = await orionFetch('/api/notes/search', {
        method: 'POST',
        body: JSON.stringify(body),
      })

      const r = result as { query: string; model: string; results: Array<{
        noteId: string; title: string; content: string; type: string; folder: string; pinned: boolean; score: number
      }> }
      const model = (r as any).model || 'unknown'

      if (r.results.length === 0) {
        return `No semantically similar notes found for "${body.query}".\n\n` +
          `This usually means embeddings have not been generated yet.\n` +
          `Run knowledge_embed_all to generate embeddings for all notes.`
      }

      const lines: string[] = [`Found ${r.results.length} semantically related notes for "${body.query}" (model: ${model}):`]
      for (let i = 0; i < r.results.length; i++) {
        const note = r.results[i]
        lines.push('')
        lines.push(`--- #${i + 1} [${note.type}] ${note.title} (similarity: ${note.score.toFixed(3)}) ---`)
        lines.push(`Folder: ${note.folder} | Pinned: ${note.pinned}`)
        if (body.includeContent) {
          const preview = note.content.slice(0, 1000)
          lines.push(preview)
          if (note.content.length > 1000) lines.push('... (truncated)')
        }
      }
      return lines.join('\n')
    },
  },

  {
    name: 'knowledge_graph',
    description: 'Get the full knowledge graph data for ORION notes. ' +
      'Returns nodes (all notes) and links (wikilinks + semantic vector-similarity edges). ' +
      'Use this to understand how notes are interconnected.',
    inputSchema: {
      type: 'object',
      properties: {
        includeSemantic: {
          type: 'boolean',
          description: 'Include semantic (vector-similarity) edges (default true)',
          default: true,
        },
        includeWikilinks: {
          type: 'boolean',
          description: 'Include wikilink edges (default true)',
          default: true,
        },
        threshold: {
          type: 'number',
          description: 'Minimum similarity score for semantic edges 0.0-1.0 (default 0.5)',
          default: 0.5,
        },
      },
    },
    async execute(args: Record<string, unknown>) {
      const params = new URLSearchParams()
      if ((args.includeSemantic ?? true) === false) params.set('includeSemantic', 'false')
      if ((args.includeWikilinks ?? true) === false) params.set('includeWikilinks', 'false')
      const threshold = args.threshold ?? 0.5
      if (threshold !== 0.5) params.set('threshold', String(threshold))

      const qs = params.toString()
      const result = await orionFetch(`/api/notes/graph-data${qs ? '?' + qs : ''}`)

      const r = result as { nodes: Array<{ id: string; title: string; type: string; folder: string; pinned: boolean }>; links: Array<{ source: string; target: string; type?: string; score?: number }>; counts?: { wikilinks: number; semantic: number } }

      const lines: string[] = []
      lines.push(`Knowledge graph: ${r.nodes.length} notes, ${r.links.length} total links`)
      if (r.counts) {
        lines.push(`  Wikilinks: ${r.counts.wikilinks} | Semantic: ${r.counts.semantic}`)
      }
      lines.push('')

      // Summary by type
      const typeCounts: Record<string, number> = {}
      for (const node of r.nodes) {
        typeCounts[node.type] = (typeCounts[node.type] || 0) + 1
      }
      lines.push('Notes by type:')
      for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
        lines.push(`  ${type}: ${count}`)
      }

      // Top nodes by connection count
      const connectionCount: Record<string, number> = {}
      for (const node of r.nodes) connectionCount[node.id] = 0
      for (const link of r.links) {
        connectionCount[link.source] = (connectionCount[link.source] || 0) + 1
        connectionCount[link.target] = (connectionCount[link.target] || 0) + 1
      }

      const topConnected = r.nodes
        .map(n => ({ id: n.id, title: n.title, connections: connectionCount[n.id] || 0 }))
        .sort((a, b) => b.connections - a.connections)
        .slice(0, 10)

      lines.push('')
      lines.push('Most connected notes:')
      for (const n of topConnected) {
        lines.push(`  ${n.title} (${n.connections} connections)`)
      }

      return lines.join('\n')
    },
  },

  {
    name: 'knowledge_related',
    description: 'Find notes semantically related to a specific note. ' +
      'Returns the top-N most similar notes with similarity scores. ' +
      'Useful for discovering related documentation when reading a note.',
    inputSchema: {
      type: 'object',
      properties: {
        noteTitle: {
          type: 'string',
          description: 'Title of the note to find related notes for',
        },
        noteId: {
          type: 'string',
          description: 'OR note ID (CUID) if title is ambiguous',
        },
        limit: {
          type: 'number',
          description: 'Max results (default 5)',
          default: 5,
        },
      },
      required: [],
    },
    async execute(args: Record<string, unknown>) {
      const limit = Math.min(Math.max(parseInt(String(args.limit ?? 5), 10), 1), 20)

      // Find the target note
      let noteId: string
      let noteTitle: string
      let noteContent: string

      if (args.noteId) {
        const noteData = await orionFetch(`/api/notes/${args.noteId}`) as { title: string; content: string; id: string }
        noteId = noteData.id
        noteTitle = noteData.title
        noteContent = noteData.content
      } else if (args.noteTitle) {
        const notes = await orionFetch('/api/notes') as Array<{ id: string; title: string; content: string }>
        const title = (args.noteTitle as string).toLowerCase()
        const match = notes.find(n => n.title.toLowerCase() === title)
        if (!match) {
          const suggestions = notes
            .filter(n => n.title.toLowerCase().includes(title))
            .slice(0, 5)
            .map(n => `  - ${n.title}`)
          return `Note "${args.noteTitle}" not found.\n\nSuggestions:\n${suggestions.join('\n')}`
        }
        noteId = match.id
        noteTitle = match.title
        noteContent = match.content
      } else {
        return 'Error: Provide either noteTitle or noteId'
      }

      // Use the note's content as the search query to find similar notes
      const searchResult = await orionFetch('/api/notes/search', {
        method: 'POST',
        body: JSON.stringify({
          query: noteContent.slice(0, 2000),
          limit: limit + 1, // +1 to account for self-filtering
        }),
      }) as { results: Array<{ noteId: string; title: string; score: number }> }

      // Filter out self and return top-N
      const related = searchResult.results
        .filter((r: { noteId: string; title: string; score: number }) => r.noteId !== noteId)
        .slice(0, limit)

      if (related.length === 0) {
        return `No semantically related notes found for "${noteTitle}".\n\n` +
          `Ensure embeddings have been generated with knowledge_embed_all.`
      }

      const lines: string[] = [`Semantically related to "${noteTitle}":`]
      for (const r of related) {
        lines.push(`  ${r.title} (score: ${r.score.toFixed(3)})`)
      }
      return lines.join('\n')
    },
  },

  {
    name: 'knowledge_backlinks',
    description: 'Find all notes that contain a wikilink reference ([[Note Title]]) to a specific note. ' +
      'This is a text-based search, not vector similarity.',
    inputSchema: {
      type: 'object',
      properties: {
        noteTitle: {
          type: 'string',
          description: 'The note title to find backlinks for',
        },
      },
      required: ['noteTitle'],
    },
    async execute(args: Record<string, unknown>) {
      const targetTitle = String(args.noteTitle)
      const notes = await orionFetch('/api/notes') as Array<{ id: string; title: string; content: string }>

      const backlinks = notes.filter(note => {
        if (note.title === targetTitle) return false
        // Check for [[Note Title]] pattern
        const regex = new RegExp(`\\[\\[${targetTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\]`, 'g')
        return regex.test(note.content)
      })

      if (backlinks.length === 0) {
        return `No notes wikilink to "${targetTitle}".`
      }

      const lines: string[] = [`Notes that reference "${targetTitle}" (${backlinks.length}):`]
      for (const note of backlinks) {
        lines.push(`  - ${note.title}`)
      }
      return lines.join('\n')
    },
  },

  {
    name: 'knowledge_embed_all',
    description: 'Generate vector embeddings for all notes in the ORION knowledge base. ' +
      'This enables semantic search and the knowledge graph visualization. ' +
      'May take several minutes depending on note count. Returns progress.',
    inputSchema: {
      type: 'object',
      properties: {
        force: {
          type: 'boolean',
          description: 'Force re-embedding even if embeddings already exist',
          default: false,
        },
      },
    },
    async execute(_args: Record<string, unknown>) {
      const result = await orionFetch('/api/notes/embed/rebuild', {
        method: 'POST',
      }) as { notesEmbedded: number; embedFailed: number; connectionsComputed: number; connectionsFailed: number }

      return (
        `Embedding complete:\n` +
        `  Notes embedded: ${result.notesEmbedded}\n` +
        `  Embed failures: ${result.embedFailed}\n` +
        `  Connections computed: ${result.connectionsComputed}\n` +
        `  Connection failures: ${result.connectionsFailed}\n\n` +
        `Knowledge graph and semantic search are now available.`
      )
    },
  },
]
