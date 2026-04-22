/**
 * Wikilink utilities for the knowledge graph.
 * Parses [[Note Title]] and [[Note Title|Alias]] syntax from markdown content.
 */

export interface Wikilink {
  /** The target note title (as written) */
  title: string
  /** Optional alias/label displayed in the source */
  alias?: string
  /** The resolved target title (alias falls back to title) */
  target: string
}

/**
 * Extract all [[wikilink]] references from markdown content.
 * Supports: [[Title]], [[Title|Alias]]
 */
export function parseWikilinks(content: string): Wikilink[] {
  const results: Wikilink[] = []
  // Match [[title]] or [[title|alias]]
  const regex = /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g
  let match
  while ((match = regex.exec(content)) !== null) {
    const rawTitle = match[1].trim()
    const alias = match[2]?.trim()
    results.push({
      title: rawTitle,
      alias,
      target: alias || rawTitle,
    })
  }
  return results
}

/**
 * Parse wikilinks that point OUT from each note (edges in the graph).
 * Returns { from, to } pairs where 'from' is the source note and 'to' is the target.
 */
export function computeOutgoingEdges(
  notes: Array<{ id: string; title: string; content: string }>,
): Array<{ source: string; sourceTitle: string; target: string; targetTitle: string }> {
  // Build a title→note lookup
  const byTitle = new Map<string, { id: string; title: string }>()
  for (const note of notes) {
    byTitle.set(note.title, { id: note.id, title: note.title })
  }

  const edges: Array<{ source: string; sourceTitle: string; target: string; targetTitle: string }> = []

  for (const note of notes) {
    const links = parseWikilinks(note.content)
    for (const link of links) {
      const targetNote = byTitle.get(link.target)
      if (targetNote && targetNote.id !== note.id) {
        edges.push({
          source: note.id,
          sourceTitle: note.title,
          target: targetNote.id,
          targetTitle: targetNote.title,
        })
      }
    }
  }

  return edges
}

/**
 * Find all notes that reference the given note title (backlinks).
 */
export function findBacklinks(
  notes: Array<{ id: string; title: string; content: string }>,
  targetTitle: string,
): Array<{ id: string; title: string }> {
  const target = targetTitle
  return notes.filter(note => {
    if (note.title === target) return false
    const links = parseWikilinks(note.content)
    return links.some(l => l.target === target)
  }).map(n => ({ id: n.id, title: n.title }))
}
