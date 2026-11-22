/**
 * Pure parts of Dream's synthesis phase (dream.ts runSynthesis): batching, the
 * prompt, parsing the reply and rendering/merging hub notes.
 *
 * Synthesis used to send every note title in one prompt and let the model answer
 * freely. At ~900 notes a reasoning model thought until the request timed out, so
 * the phase never finished. Now: small batches by folder, a bounded number of
 * hubs and tokens, no reasoning trace, and a JSON schema where the server takes one.
 */

export interface SynthesisNote {
  title: string
  folder: string
  tags: unknown
}

const links = (content: string, title: string) => content.includes(`[[${title}]]`)

/**
 * Titles (trimmed) that a hub already links to: every link mergeHub writes, plus
 * hand-written [[title|alias]] and [[title#heading]].
 */
export function linkedTitles(titles: string[], hubContents: string[]): Set<string> {
  const all = hubContents.join('\n')
  const known = new Set(titles.map(t => t.trim()))
  const linked = new Set([...known].filter(t => links(all, t)))
  for (const [, target] of all.matchAll(/\[\[(.+?)\]\]/g)) {
    const base = target.split(/[|#]/)[0].trim()
    if (!known.has(target.trim()) && known.has(base)) linked.add(base) // not when "C# tips" is itself a note
  }
  return linked
}

export interface ProposedHub {
  title: string
  overview: string
  notes: string[]
  folder: string
}

export const SYNTHESIS_BATCH_NOTES = 120
/** Per reply. */
export const SYNTHESIS_MAX_HUBS = 5
/** New hub notes per run, over all batches: the phase runs twice a day. */
export const SYNTHESIS_MAX_NEW_HUBS = 10
/** Enough for SYNTHESIS_MAX_HUBS hubs listing a whole batch (about 2,500 tokens measured). */
export const SYNTHESIS_MAX_TOKENS = 6000
/** Existing hub titles listed in each prompt, most recently updated first. */
export const SYNTHESIS_MAX_EXISTING = 300
export const HUB_FOLDERS = ['Infrastructure', 'Agent Patterns', 'GitOps', 'Security', 'Networking', 'Observability']

export const SYNTHESIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['hubs'],
  properties: {
    hubs: {
      type: 'array',
      maxItems: SYNTHESIS_MAX_HUBS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'overview', 'notes', 'folder'],
        properties: {
          title: { type: 'string' },
          overview: { type: 'string' },
          notes: { type: 'array', minItems: 1, maxItems: 40, items: { type: 'string' } },
          folder: { type: 'string', enum: HUB_FOLDERS },
        },
      },
    },
  },
}

export function isHub(tags: unknown): boolean {
  return Array.isArray(tags) && tags.includes('hub')
}

/** A hub Dream owns, and may therefore extend. */
export function isDreamHub(tags: unknown): boolean {
  return isHub(tags) && (tags as unknown[]).includes('dream')
}

/**
 * Batches of at most `size` notes: those that are neither hubs nor linked from one
 * yet, so the work shrinks as hubs appear instead of proposing new ones for the
 * same notes forever. A folder stays together where it fits (its notes are the
 * likeliest clusters); small folders share a batch.
 */
export function synthesisBatches(notes: SynthesisNote[], linked: ReadonlySet<string> = new Set(), size = SYNTHESIS_BATCH_NOTES): SynthesisNote[][] {
  const byFolder = new Map<string, SynthesisNote[]>()
  for (const n of notes) {
    if (isHub(n.tags) || linked.has(n.title.trim())) continue
    byFolder.set(n.folder, [...(byFolder.get(n.folder) ?? []), n])
  }
  const batches: SynthesisNote[][] = []
  let open: SynthesisNote[] = []
  for (const group of [...byFolder.values()].sort((a, b) => b.length - a.length)) {
    for (let i = 0; i < group.length; i += size) {
      const chunk = group.slice(i, i + size)
      if (open.length + chunk.length > size) {
        batches.push(open)
        open = []
      }
      open = [...open, ...chunk]
    }
  }
  if (open.length) batches.push(open)
  // A note left alone in a batch can't be clustered there: it joins its neighbour.
  for (let i = batches.length - 1; i >= 0 && batches.length > 1; i--) {
    if (batches[i].length > 1) continue
    const [lone] = batches.splice(i, 1)
    batches[Math.max(0, i - 1)].push(...lone)
  }
  return batches.filter(b => b.length >= 2)
}

/** Titles under folder headings: a [folder] prefix on each gets copied into the answer. */
function noteList(batch: SynthesisNote[]): string {
  const folders = [...new Set(batch.map(n => n.folder))]
  return folders
    .map(f => `Folder: ${f}\n${batch.filter(n => n.folder === f).map(n => `- ${n.title}`).join('\n')}`)
    .join('\n\n')
}

export function synthesisPrompt(batch: SynthesisNote[], existingHubs: string[]): string {
  return `You are a knowledge architect for an AI agent team managing a Kubernetes homelab cluster.

Below is one part of the current knowledge base: specific notes extracted from agent activity. Identify missing "hub" notes that should exist to connect related specifics into a coherent knowledge graph.

EXISTING HUB NOTES:
${existingHubs.slice(0, SYNTHESIS_MAX_EXISTING).map(t => `- ${t}`).join('\n') || '(none)'}

NOTES:
${noteList(batch)}

Instructions:
- To add notes to an existing hub, use its exact title from the list above. Prefer this to a new hub on nearly the same topic.
- For each other cluster of 2 or more related notes, propose one new hub note with a broad topic title (e.g. "ESO & Vault Secret Management", "Agent Coordination Patterns").
- "overview": 2-4 sentences summarising the topic.
- "notes": the exact titles of the notes in the cluster, copied from NOTES.
- At most ${SYNTHESIS_MAX_HUBS} hubs in total, the most useful ones. Do NOT propose new hubs for one-off notes.

Respond with JSON only:
{"hubs": [{"title": "...", "overview": "...", "notes": ["...", "..."], "folder": ${HUB_FOLDERS.map(f => `"${f}"`).join(' | ')}}]}

If there is nothing to add: {"hubs": []}`
}

/** A title as the model wrote it: sometimes with a list dash, or as a [[wikilink]]. */
function noteTitle(raw: string, titles: ReadonlySet<string>): string {
  const t = raw.trim()
  if (titles.has(t)) return t
  return t.replace(/^-\s+/, '').replace(/^\[\[(.+)\]\]$/, '$1').trim()
}

/** The JSON value starting at `start`, cut at its matching bracket, or null. */
function jsonAt(raw: string, start: number): unknown {
  let depth = 0, inString = false
  for (let i = start; i < raw.length; i++) {
    const c = raw[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '{' || c === '[') depth++
    else if ((c === '}' || c === ']') && --depth === 0) {
      try { return JSON.parse(raw.slice(start, i + 1)) } catch { return null }
    }
  }
  return null
}

function findHubList(raw: string): unknown[] | null {
  for (const m of raw.matchAll(/\{\s*"hubs"/g)) {
    const hubs = (jsonAt(raw, m.index) as { hubs?: unknown } | null)?.hubs
    if (Array.isArray(hubs)) return hubs
  }
  for (const m of raw.matchAll(/\[\s*(?:\{|\])/g)) {
    const list = jsonAt(raw, m.index)
    if (Array.isArray(list)) return list
  }
  return null
}

/**
 * The hub list in a reply: {"hubs": [...]} or a bare array, whatever text surrounds
 * it. Reasoning left in the text ends with </think> (its opening tag may be in the
 * prompt), so what follows the last one is tried first; when that has no list, the
 * tag was inside the answer (a note title) and the whole reply is read.
 */
function hubList(reply: string): unknown[] {
  const end = reply.lastIndexOf('</think>')
  const list = (end >= 0 ? findHubList(reply.slice(end + '</think>'.length)) : null) ?? findHubList(reply)
  if (!list) throw new Error('no hub list in the reply')
  return list
}

/**
 * Hubs in a reply, keeping only links to notes that are really in the batch (the
 * model paraphrases some titles). A new hub must still connect two of them; an
 * existing one (`existingHubs`) may gain a single note. Throws when the reply has
 * no hub list.
 */
export function parseHubs(reply: string, batch: SynthesisNote[], existingHubs: readonly string[] = []): ProposedHub[] {
  const titles = new Set(batch.map(n => n.title.trim()))
  const hubs: ProposedHub[] = []
  for (const item of hubList(reply) as Array<Partial<Record<keyof ProposedHub, unknown>> | null>) {
    if (typeof item?.title !== 'string' || typeof item.overview !== 'string' || !Array.isArray(item.notes)) continue
    const title = item.title.trim()
    const notes = [...new Set(item.notes.filter((t): t is string => typeof t === 'string').map(t => noteTitle(t, titles)))]
      .filter(t => titles.has(t) && t !== title)
    if (!title || !item.overview.trim() || notes.length < (existingHubs.includes(title) ? 1 : 2)) continue
    hubs.push({
      title,
      overview: item.overview.trim(),
      notes,
      folder: HUB_FOLDERS.includes(item.folder as string) ? (item.folder as string) : 'Infrastructure',
    })
  }
  return hubs.slice(0, SYNTHESIS_MAX_HUBS)
}

const linkList = (titles: string[]) => titles.map(t => `- [[${t}]]`).join('\n')

export function renderHub(hub: ProposedHub): string {
  return `## Overview\n${hub.overview}\n\n## Notes in this cluster\n${linkList(hub.notes)}`
}

/**
 * An existing hub's content with the missing links appended. Never rewritten: each
 * batch sees only part of the notes, so replacing it would drop the others' links.
 * Returns null when there is nothing to add.
 */
export function mergeHub(existing: string, hub: ProposedHub): string | null {
  const missing = hub.notes.filter(t => !links(existing, t))
  if (missing.length === 0) return null
  return `${existing.replace(/\s+$/, '')}\n${linkList(missing)}`
}
