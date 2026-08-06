/**
 * Dream — memory consolidation for ORION.
 *
 * Four phases, run on separate schedules:
 *
 * 1. EXTRACTION (every 2 hours)
 *    Scans recent chat messages and task events since the last run.
 *    Passes existing note titles so the LLM can [[wikilink]] to related notes.
 *    Writes each extracted item as a Note + immediately embeds it + computes edges.
 *
 * 2. SYNTHESIS (every 12 hours)
 *    Groups all notes by folder/tag cluster.
 *    Asks an LLM to identify missing mid-level "hub" notes that should connect
 *    related specifics (e.g. "ESO Secret Sync Patterns" tying together multiple
 *    Tailscale/Vault/cert-manager notes). Writes hub notes with [[wikilinks]] to
 *    their members so the graph has structure beyond leaf-level facts.
 *
 * 3. PRUNING (every 24 hours)
 *    Reads all notes in the knowledge base.
 *    Sends each note to an LLM with recent system context.
 *    Deletes notes the LLM marks as stale or superseded.
 *
 * 4. SKILL CRAFTING (every 12 hours)
 *    Reviews recently completed tasks since the last run. Asks an LLM which of
 *    them represent a repeatable procedure (not a one-off) worth generalizing
 *    into a reusable skill, and to produce step-by-step instructions + trigger
 *    phrases for those. Writes them as NebulaInstance(category:'skill',
 *    source:'dream') — the same model agents write to via the save_skill tool
 *    and the Nebula UI writes to for human-authored skills.
 *
 * Last-run timestamps are stored in SystemSetting:
 *   dream.extractionLastRun     — unix ms
 *   dream.synthesisLastRun      — unix ms
 *   dream.pruningLastRun        — unix ms
 *   dream.skillCraftingLastRun  — unix ms
 */

import { prisma } from './db'
import { embedNote, computeSemanticEdges, embedSkill } from './embeddings'
import { estimateTokens } from './token-budget'
import {
  type SkillSpec,
  validateSkillContent,
  resolveAgentPrimaryEnvironmentId,
  MIN_TRIGGER_PATTERN_LEN,
  MAX_TRIGGER_PATTERNS,
  MAX_STEPS,
  MAX_STEP_LEN,
} from './skill-tools'

// ── Config ────────────────────────────────────────────────────────────────────

const EXTRACTION_INTERVAL_MS      = 2  * 60 * 60 * 1000  // 2 hours
const SYNTHESIS_INTERVAL_MS       = 12 * 60 * 60 * 1000  // 12 hours
const PRUNING_INTERVAL_MS         = 24 * 60 * 60 * 1000  // 24 hours
const SKILL_CRAFTING_INTERVAL_MS  = 12 * 60 * 60 * 1000  // 12 hours
const EXTRACTION_BATCH       = 80   // messages per LLM call
const PRUNING_BATCH          = 20   // notes per pruning LLM call
const SKILL_CRAFTING_BATCH   = 15   // completed tasks reviewed per LLM call
const MAX_NOTE_AGE_DAYS      = 90   // never auto-delete notes newer than this

// ── LLM routing ───────────────────────────────────────────────────────────────
// dream.model SystemSetting controls which model runs dream. Falls back to
// ai.default-model, then falls back again if the specified model errors.

async function getDreamModelId(): Promise<string> {
  const dreamModel = await prisma.systemSetting.findUnique({ where: { key: 'dream.model' } })
  if (dreamModel?.value && typeof dreamModel.value === 'string') return dreamModel.value

  // Fall back to system default
  const { getDefaultModelId } = await import('./default-model')
  return getDefaultModelId()
}

interface LLMCallResult {
  text: string
  inputTokens: number
  outputTokens: number
  reasoning?: string
}

async function callWithModel(modelId: string, prompt: string): Promise<LLMCallResult> {
  const CLAUDE_URL = process.env.ORION_CLAUDE_URL ?? 'http://orion-claude:3100'

  if (modelId === 'claude' || modelId.startsWith('claude:')) {
    const model = modelId.startsWith('claude:') ? modelId.slice('claude:'.length) : undefined
    const res = await fetch(`${CLAUDE_URL}/run/collect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, ...(model ? { model } : {}), maxTurns: 1 }),
      signal: AbortSignal.timeout(90_000),
    })
    if (!res.ok) throw new Error(`orion-claude HTTP ${res.status}`)
    const json = await res.json() as {
      text?: string
      usage?: { inputTokens?: number; outputTokens?: number }
      inputTokens?: number
      outputTokens?: number
    }
    const text = json.text ?? ''
    // orion-claude sidecar doesn't reliably surface usage on /run/collect — use
    // it if present, otherwise fall back to a length-based estimate. Input
    // tokens are estimated from the prompt since the sidecar never echoes it.
    const inputTokens  = json.usage?.inputTokens  ?? json.inputTokens  ?? estimateTokens(prompt)
    const outputTokens = json.usage?.outputTokens ?? json.outputTokens ?? estimateTokens(text)
    return { text, inputTokens, outputTokens }
  }

  // External model (OpenAI-compatible or Ollama)
  const extModel = await prisma.externalModel.findUnique({ where: { id: modelId } })
  if (!extModel) throw new Error(`dream.model '${modelId}' not found`)

  if (extModel.provider === 'ollama') {
    const res = await fetch(`${extModel.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: extModel.modelId, prompt, stream: false }),
      signal: AbortSignal.timeout(90_000),
    })
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`)
    const data = await res.json() as { response?: string; prompt_eval_count?: number; eval_count?: number }
    const text = data.response?.trim() ?? ''
    const inputTokens  = data.prompt_eval_count ?? estimateTokens(prompt)
    const outputTokens = data.eval_count ?? estimateTokens(text)
    return { text, inputTokens, outputTokens }
  }

  // OpenAI-compatible
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (extModel.apiKey) headers['Authorization'] = `Bearer ${extModel.apiKey}`
  const res = await fetch(`${extModel.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: extModel.modelId,
      stream: false,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout((extModel.timeoutSecs ?? 120) * 1000),
  })
  if (!res.ok) throw new Error(`External model HTTP ${res.status}`)
  const data = await res.json() as {
    choices?: Array<{ message: { content: string; reasoning_content?: string } }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  const text = data.choices?.[0]?.message?.content?.trim() ?? ''
  const reasoning = data.choices?.[0]?.message?.reasoning_content?.trim() || undefined
  const inputTokens  = data.usage?.prompt_tokens     ?? estimateTokens(prompt)
  const outputTokens = data.usage?.completion_tokens ?? estimateTokens(text)
  return { text, inputTokens, outputTokens, reasoning }
}

// Cache only positive hits — a miss (e.g. queried before ensureSystemAgents()
// has committed the Dream row on a fresh install/boot) must retry on the next
// call rather than permanently caching null for the process lifetime.
let _dreamAgentIdCache: string | null = null
async function getDreamAgentId(): Promise<string | null> {
  if (_dreamAgentIdCache !== null) return _dreamAgentIdCache
  const agent = await prisma.agent.findUnique({ where: { name: 'Dream' }, select: { id: true } })
  _dreamAgentIdCache = agent?.id ?? null
  return _dreamAgentIdCache
}

// One-time-per-process warning so a fresh install (or a worker process that
// never calls ensureSystemAgents()) doesn't silently drop Dream token
// accounting forever without any log signal.
let _dreamAgentMissingWarnedOnce = false

async function recordDreamUsage(inputTokens: number, outputTokens: number, modelId: string): Promise<void> {
  try {
    const dreamAgentId = await getDreamAgentId()
    if (!dreamAgentId) {
      if (!_dreamAgentMissingWarnedOnce) {
        console.warn('[dream] Dream agent not found — token usage not recorded. Ensure ensureSystemAgents() has run.')
        _dreamAgentMissingWarnedOnce = true
      }
      return
    }
    const { recordTokenUsage } = await import('./token-budget')
    await recordTokenUsage(dreamAgentId, null, inputTokens, outputTokens, modelId)
  } catch (err) {
    console.error('[dream] Failed to record token usage:', err)
    _dreamAgentIdCache = null  // retry lookup next time — agent may have been renamed/recreated
  }
}

interface DreamLLMResult {
  text: string
  reasoning?: string
}

async function callLLM(prompt: string, jobType: 'extraction' | 'synthesis' | 'pruning' | 'skill_crafting'): Promise<DreamLLMResult> {
  const modelId = await getDreamModelId()

  try {
    const result = await callWithModel(modelId, prompt)
    await recordDreamUsage(result.inputTokens, result.outputTokens, modelId)
    await recordDreamReasoning(jobType, result.reasoning)
    return { text: result.text, reasoning: result.reasoning }
  } catch (primaryErr) {
    console.warn(`[dream] Model '${modelId}' failed (${primaryErr}), falling back to system default`)

    const { getDefaultModelId } = await import('./default-model')
    const defaultId = await getDefaultModelId()

    if (defaultId === modelId) throw primaryErr  // same model, don't retry

    const result = await callWithModel(defaultId, prompt)
    await recordDreamUsage(result.inputTokens, result.outputTokens, defaultId)
    await recordDreamReasoning(jobType, result.reasoning)
    return { text: result.text, reasoning: result.reasoning }
  }
}

// Persists the model's <think> trace (when the provider separates it out — see
// --reasoning-format deepseek on the local llama-server) as AgentKnowledge so it
// can later be used as reasoning-supervision data for LoRA training. Output-only
// callers (extraction/synthesis/pruning results) are stored separately in Note —
// this captures the process, not the product.
async function recordDreamReasoning(jobType: string, reasoning: string | undefined): Promise<void> {
  if (!reasoning) return
  try {
    const dreamAgentId = await getDreamAgentId()
    if (!dreamAgentId) return
    await prisma.agentKnowledge.create({
      data: {
        agentId: dreamAgentId,
        title:   `${jobType} reasoning — ${new Date().toISOString()}`,
        content: reasoning,
        type:    'reasoning-trace',
        tags:    [jobType, 'dream', 'reasoning-trace'] as any,
      },
    })
  } catch (e) {
    console.error('[dream] Failed to record reasoning trace:', e)
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getSetting(key: string): Promise<string | null> {
  return prisma.systemSetting.findUnique({ where: { key } })
    .then(r => (typeof r?.value === 'string' ? r.value : null))
}

async function setSetting(key: string, value: string): Promise<void> {
  await prisma.systemSetting.upsert({
    where:  { key },
    update: { value },
    create: { key, value },
  })
}

// ── Extraction ────────────────────────────────────────────────────────────────

/**
 * Extract durable memories from recent messages and task events.
 * Called every EXTRACTION_INTERVAL_MS.
 */
export async function runExtraction(): Promise<void> {
  const lastRunStr = await getSetting('dream.extractionLastRun')
  const lastRun    = lastRunStr ? new Date(parseInt(lastRunStr, 10)) : new Date(0)
  const now        = new Date()

  console.log(`[dream] Extraction — scanning since ${lastRun.toISOString()}`)

  // Gather recent chat messages (assistant + tool_call only — skip human/system noise)
  const messages = await prisma.chatMessage.findMany({
    where: {
      createdAt:  { gt: lastRun },
      senderType: { in: ['agent', 'tool_call'] },
    },
    orderBy: { createdAt: 'asc' },
    take: EXTRACTION_BATCH * 3,
    select: {
      senderType:  true,
      content:     true,
      attachments: true,
      createdAt:   true,
      agent:       { select: { name: true } },
    },
  })

  // Gather recent task events (agent output + tool results)
  const events = await prisma.taskEvent.findMany({
    where: {
      createdAt: { gt: lastRun },
      eventType: { in: ['tool_call', 'tool_result', 'agent_output', 'note'] },
    },
    orderBy: { createdAt: 'asc' },
    take: EXTRACTION_BATCH * 2,
    select: {
      eventType: true,
      content:   true,
      createdAt: true,
      task:      { select: { title: true } },
    },
  })

  if (messages.length === 0 && events.length === 0) {
    console.log('[dream] Extraction — no new content, skipping')
    await setSetting('dream.extractionLastRun', String(now.getTime()))
    return
  }

  // Fetch existing note titles so the LLM can wikilink to related notes
  const existingNotes = await prisma.note.findMany({
    select: { title: true, folder: true },
    orderBy: { updatedAt: 'desc' },
  })
  const existingTitles = existingNotes
    .map(n => `  - ${n.title} (${n.folder})`)
    .join('\n')

  // Build text corpus for the LLM
  const messageLines = messages.map(m => {
    const who    = m.agent?.name ?? m.senderType
    const attach = m.attachments as Record<string, string> | null
    const body   = attach?.output ?? m.content ?? ''
    return `[${who}] ${body.slice(0, 400)}`
  })

  const eventLines = events.map(e => {
    const task = e.task?.title ? `(task: ${e.task.title}) ` : ''
    return `[${e.eventType}] ${task}${(e.content ?? '').slice(0, 400)}`
  })

  // BLOCKER fix: build corpus with a budget and track the watermark to only the
  // last row that actually fit. Previously: all rows were fetched, corpus was
  // blindly sliced to 12k, but watermark advanced to now() unconditionally —
  // content past the 12k cut was permanently skipped on the next run.
  const allRows = [
    ...messages.map(m => ({ ts: m.createdAt, line: messageLines[messages.indexOf(m)] })),
    ...events.map(e => ({ ts: e.createdAt, line: eventLines[events.indexOf(e)] })),
  ].sort((a, b) => a.ts.getTime() - b.ts.getTime())

  let corpusBudget = 0
  let processedThrough = lastRun
  const corpusLines: string[] = []
  for (const row of allRows) {
    if (corpusBudget + row.line.length + 1 > 12_000) break
    corpusLines.push(row.line)
    corpusBudget += row.line.length + 1
    processedThrough = row.ts
  }
  const corpus = corpusLines.join('\n')

  const extractionPrompt = `You are a memory consolidation system for an AI agent team managing a Kubernetes homelab cluster.

Review the following recent agent messages and task events, then extract durable facts, lessons, and patterns worth remembering for future tasks.

EXISTING KNOWLEDGE BASE NOTES:
${existingTitles || '  (none yet)'}

CONTENT:
${corpus}

Instructions:
- Extract only DURABLE items: things that will still be true next week (cluster quirks, known patterns, successful approaches, failure root causes, service configurations).
- Skip transient state: "pod is running now", "task assigned", routine status updates.
- Skip anything too vague to be actionable.
- Each memory must be self-contained and searchable.
- In the content field, use [[Note Title]] wikilink syntax to reference related existing notes by their exact title. This builds the knowledge graph — link to any note above that is genuinely related.

Respond with a JSON array (and nothing else). Each item:
{
  "title": "short searchable title including domain/service name",
  "content": "## Context\\n...\\n## Lesson\\n...\\n## Rules for Next Time\\n- ...\\n## Related\\n- [[Exact Title of Related Note]]",
  "folder": "Success Patterns" | "Failure Patterns" | "Cluster Quirks" | "Tool Usage" | "Agent Lessons" | "Infrastructure",
  "tags": ["tag1", "tag2"]
}

If nothing is worth remembering, return an empty array: []`

  let extracted: Array<{ title: string; content: string; folder: string; tags: string[] }> = []
  try {
    const raw = (await callLLM(extractionPrompt, 'extraction')).text
    const jsonMatch = raw.match(/\[[\s\S]*\]/)
    if (jsonMatch) extracted = JSON.parse(jsonMatch[0])
  } catch (e) {
    console.error('[dream] Extraction LLM/parse error:', e)
  }

  console.log(`[dream] Extraction — writing ${extracted.length} memories`)

  let written = 0
  for (const item of extracted) {
    if (!item.title?.trim() || !item.content?.trim()) continue
    try {
      // MAJOR fix: scope dream note lookups to dream-owned notes only.
      // Previously matched by title alone — if a human note shared a title (e.g.
      // "Networking", "Security"), dream would append/overwrite it. Now we only
      // touch notes tagged 'dream', preventing cross-contamination with human notes.
      const existing = await prisma.note.findFirst({
        where: { title: item.title.trim(), tags: { array_contains: 'dream' } },
      })
      let note: { id: string; title: string; content: string }

      if (existing) {
        // Append new information rather than overwrite
        const merged = existing.content + '\n\n---\n*Updated by dream consolidation*\n' + item.content
        note = await prisma.note.update({
          where: { id: existing.id },
          data: { content: merged, updatedAt: new Date() },
        })
      } else {
        const dreamTags = Array.from(new Set(['dream', ...(item.tags ?? [])]))
        note = await prisma.note.create({
          data: {
            title:   item.title.trim(),
            content: item.content.trim(),
            folder:  item.folder ?? 'Agent Lessons',
            type:    'note',
            tags:    dreamTags as any,
          },
        })
      }

      const embedded = await embedNote(note, { attributeToDream: true }).catch(() => false)
      if (embedded) await computeSemanticEdges(note.id).catch(() => {})
      written++
    } catch (e) {
      console.error('[dream] Failed to write memory:', item.title, e)
    }
  }

  // Use the watermark of the last processed row, not now(), to avoid skipping
  // content that didn't fit in the 12k corpus window
  await setSetting('dream.extractionLastRun', String(processedThrough.getTime()))
  console.log(`[dream] Extraction complete — wrote ${written}/${extracted.length} memories (processed through ${processedThrough.toISOString()})`)
}

// ── Synthesis ─────────────────────────────────────────────────────────────────

/**
 * Identify missing hub notes that should connect clusters of related specifics.
 * Creates mid-level "Infrastructure", "Agent Patterns", and topic-level notes
 * that [[wikilink]] to their members — giving the knowledge graph real structure.
 * Called every SYNTHESIS_INTERVAL_MS.
 */
export async function runSynthesis(): Promise<void> {
  const lastRunStr = await getSetting('dream.synthesisLastRun')
  const lastRun    = lastRunStr ? new Date(parseInt(lastRunStr, 10)) : new Date(0)
  const now        = new Date()

  console.log(`[dream] Synthesis — last run ${lastRun.toISOString()}`)

  const notes = await prisma.note.findMany({
    select: { id: true, title: true, folder: true, tags: true, content: true },
    orderBy: { updatedAt: 'desc' },
  })

  if (notes.length < 5) {
    console.log('[dream] Synthesis — not enough notes yet, skipping')
    await setSetting('dream.synthesisLastRun', String(now.getTime()))
    return
  }

  const noteIndex = notes
    .map(n => `  [${n.folder}] ${n.title}`)
    .join('\n')

  const synthesisPrompt = `You are a knowledge architect for an AI agent team managing a Kubernetes homelab cluster.

Below is the current knowledge base — a flat list of specific notes extracted from agent activity. Your job is to identify missing "hub" notes that should exist to connect related specifics into a coherent knowledge graph.

CURRENT NOTES:
${noteIndex}

Instructions:
- Identify clusters of related notes (e.g. multiple notes about ESO, Vault, Tailscale, agent coordination, GitOps).
- For each cluster that lacks a hub note, propose one hub note that:
  - Has a broad topic title (e.g. "ESO & Vault Secret Management", "Agent Coordination Patterns", "Tailscale Operator Setup")
  - Has content summarising what's known about that topic
  - Uses [[Note Title]] wikilinks to connect to every specific note in the cluster (use exact titles from the list above)
- Only create hubs where 2+ specific notes exist on the same topic.
- Do NOT recreate notes that already exist as hubs (check the list above).
- Do NOT create hubs for unrelated one-off notes.

Respond with a JSON array (and nothing else). Each hub note:
{
  "title": "Topic-Level Hub Title",
  "content": "## Overview\\n...summary of what is known...\\n\\n## Notes in this cluster\\n- [[Exact Note Title]]\\n- [[Exact Note Title]]",
  "folder": "Infrastructure" | "Agent Patterns" | "GitOps" | "Security" | "Networking" | "Observability",
  "tags": ["hub", "tag2"]
}

If no hubs are missing, return an empty array: []`

  let hubs: Array<{ title: string; content: string; folder: string; tags: string[] }> = []
  try {
    const raw = (await callLLM(synthesisPrompt, 'synthesis')).text
    const jsonMatch = raw.match(/\[[\s\S]*\]/)
    if (jsonMatch) hubs = JSON.parse(jsonMatch[0])
  } catch (e) {
    console.error('[dream] Synthesis LLM/parse error:', e)
  }

  console.log(`[dream] Synthesis — writing ${hubs.length} hub notes`)

  let written = 0
  for (const hub of hubs) {
    if (!hub.title?.trim() || !hub.content?.trim()) continue
    try {
      // MAJOR fix: scope synthesis lookups to dream-tagged notes only.
      // Synthesis previously matched by title alone — if a human note shared a hub
      // title, synthesis would wholesale replace its content. Now only dream-owned
      // notes are updated; a title collision with a human note creates a new note.
      const existing = await prisma.note.findFirst({
        where: { title: hub.title.trim(), tags: { array_contains: 'dream' } },
      })
      if (existing) {
        // Hub already exists — update content to reflect current cluster membership
        const note = await prisma.note.update({
          where: { id: existing.id },
          data: { content: hub.content.trim(), updatedAt: new Date() },
        })
        const embedded = await embedNote(note, { attributeToDream: true }).catch(() => false)
        if (embedded) await computeSemanticEdges(note.id).catch(() => {})
      } else {
        const dreamTags = Array.from(new Set(['dream', 'hub', ...(hub.tags ?? [])]))
        const note = await prisma.note.create({
          data: {
            title:   hub.title.trim(),
            content: hub.content.trim(),
            folder:  hub.folder ?? 'Infrastructure',
            type:    'note',
            tags:    dreamTags as any,
          },
        })
        const embedded = await embedNote(note, { attributeToDream: true }).catch(() => false)
        if (embedded) await computeSemanticEdges(note.id).catch(() => {})
      }
      written++
    } catch (e) {
      console.error('[dream] Failed to write hub note:', hub.title, e)
    }
  }

  await setSetting('dream.synthesisLastRun', String(now.getTime()))
  console.log(`[dream] Synthesis complete — wrote ${written}/${hubs.length} hub notes`)
}

// ── Pruning ───────────────────────────────────────────────────────────────────

/**
 * Review existing notes for staleness and delete ones that are no longer accurate.
 * Called every PRUNING_INTERVAL_MS.
 */
export async function runPruning(): Promise<void> {
  const lastRunStr = await getSetting('dream.pruningLastRun')
  const lastRun    = lastRunStr ? new Date(parseInt(lastRunStr, 10)) : new Date(0)
  const now        = new Date()

  console.log(`[dream] Pruning — last run ${lastRun.toISOString()}`)

  // Get notes older than minimum age (too new = not worth pruning yet)
  const minAge = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // 7 days
  const notes = await prisma.note.findMany({
    where: { updatedAt: { lt: minAge } },
    orderBy: { updatedAt: 'asc' },
    take: PRUNING_BATCH * 5,
  })

  if (notes.length === 0) {
    console.log('[dream] Pruning — no eligible notes')
    await setSetting('dream.pruningLastRun', String(now.getTime()))
    return
  }

  // Get recent system context to inform staleness decisions
  const recentEvents = await prisma.taskEvent.findMany({
    where: { createdAt: { gt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
    orderBy: { createdAt: 'desc' },
    take: 30,
    select: { eventType: true, content: true, task: { select: { title: true } } },
  })
  const recentContext = recentEvents
    .map(e => `[${e.eventType}] ${e.task?.title ?? ''}: ${(e.content ?? '').slice(0, 200)}`)
    .join('\n')

  // Process notes in batches
  let deleted = 0
  for (let i = 0; i < notes.length; i += PRUNING_BATCH) {
    const batch = notes.slice(i, i + PRUNING_BATCH)

    const noteList = batch.map((n, idx) =>
      `[${idx}] TITLE: ${n.title}\nAGE: ${Math.floor((Date.now() - n.updatedAt.getTime()) / 86400000)} days\nCONTENT: ${n.content.slice(0, 300)}`
    ).join('\n\n')

    const prunePrompt = `You are a memory curator for an AI agent team managing a Kubernetes homelab cluster.

Review the following knowledge base notes and decide which should be deleted because they are stale, superseded, or no longer accurate.

RECENT SYSTEM EVENTS (last 7 days):
${recentContext || '(none)'}

NOTES TO REVIEW:
${noteList}

For each note, respond with a JSON object. Keep your reasoning brief.
{
  "decisions": [
    { "index": 0, "delete": false, "reason": "still accurate" },
    { "index": 1, "delete": true,  "reason": "superseded by recent events showing X" }
  ]
}

Rules:
- Only mark delete:true if you are confident the information is wrong or irrelevant
- Age alone is not a reason to delete — delete only if content is stale
- When in doubt, keep the note (delete:false)
- Never delete notes with folder "Success Patterns" unless the approach is now known to fail`

    try {
      const raw = (await callLLM(prunePrompt, 'pruning')).text
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      if (!jsonMatch) continue

      const result = JSON.parse(jsonMatch[0]) as {
        decisions: Array<{ index: number; delete: boolean; reason: string }>
      }

      for (const decision of result.decisions ?? []) {
        if (!decision.delete) continue
        const note = batch[decision.index]
        if (!note) continue

        // Hard guard: never delete notes newer than MAX_NOTE_AGE_DAYS
        const ageDays = (Date.now() - note.createdAt.getTime()) / 86400000
        if (ageDays < MAX_NOTE_AGE_DAYS) {
          // Instead of deleting, append a staleness warning
          await prisma.note.update({
            where: { id: note.id },
            data: {
              content: note.content + `\n\n---\n⚠️ *Flagged as potentially stale by dream pruning: ${decision.reason}*`,
              updatedAt: new Date(),
            },
          })
        } else {
          await prisma.note.delete({ where: { id: note.id } })
          deleted++
          console.log(`[dream] Pruned: "${note.title}" — ${decision.reason}`)
        }
      }
    } catch (e) {
      console.error('[dream] Pruning batch error:', e)
    }
  }

  await setSetting('dream.pruningLastRun', String(now.getTime()))
  console.log(`[dream] Pruning complete — deleted ${deleted} stale notes`)
}

// ── Skill Crafting ────────────────────────────────────────────────────────────

/**
 * Review recently completed tasks and generalize repeatable ones into
 * reusable skills (NebulaInstance category:'skill', source:'dream').
 * Called every SKILL_CRAFTING_INTERVAL_MS.
 */
export async function runSkillCrafting(): Promise<void> {
  const lastRunStr = await getSetting('dream.skillCraftingLastRun')
  const lastRun    = lastRunStr ? new Date(parseInt(lastRunStr, 10)) : new Date(0)
  const now        = new Date()

  console.log(`[dream] Skill crafting — scanning completed tasks since ${lastRun.toISOString()}`)

  const tasks = await prisma.task.findMany({
    where: {
      status:    'done',
      updatedAt: { gt: lastRun },
    },
    orderBy: { updatedAt: 'asc' },
    take: SKILL_CRAFTING_BATCH,
    select: {
      id: true,
      title: true,
      description: true,
      assignedAgent: true,
      updatedAt: true,
      events: {
        where: { eventType: { in: ['tool_call', 'tool_result', 'agent_output'] } },
        orderBy: { createdAt: 'asc' },
        take: 40,
        select: { eventType: true, content: true },
      },
    },
  })

  if (tasks.length === 0) {
    console.log('[dream] Skill crafting — no newly completed tasks, skipping')
    await setSetting('dream.skillCraftingLastRun', String(now.getTime()))
    return
  }

  // Only tasks whose completing agent resolves to an environment can become
  // skills (skills are environment-scoped). Resolve up front so the existing-
  // skills dedupe list below is scoped to the environments actually in play,
  // not every environment in the system.
  const taskEnvIds = new Map<string, string>() // taskId -> environmentId
  for (const t of tasks) {
    if (!t.assignedAgent) continue
    const envId = await resolveAgentPrimaryEnvironmentId(t.assignedAgent)
    if (envId) taskEnvIds.set(t.id, envId)
  }

  // Existing skill names in those environments, so the LLM doesn't propose
  // near-duplicates (and so a same-named skill in an unrelated environment
  // doesn't needlessly suppress a real proposal here).
  const relevantEnvIds = Array.from(new Set(taskEnvIds.values()))
  const existingSkills = relevantEnvIds.length
    ? await prisma.nebulaInstance.findMany({
        where: { category: 'skill', environmentId: { in: relevantEnvIds } },
        select: { name: true },
      })
    : []
  const existingNames = existingSkills.map(s => `  - ${s.name}`).join('\n')

  const taskBlocks = tasks.map((t, i) => {
    const steps = t.events
      .map(e => `  [${e.eventType}] ${(e.content ?? '').slice(0, 300)}`)
      .join('\n')
    return `### Task ${i + 1}: ${t.title}\n${t.description ? `Description: ${t.description}\n` : ''}Steps taken:\n${steps || '  (no recorded steps)'}`
  }).join('\n\n')

  const craftingPrompt = `You are reviewing recently completed tasks for an AI agent team managing a Kubernetes homelab cluster, looking for ones worth generalizing into a reusable "skill" — a saved step-by-step procedure that any agent can look up and reuse next time a similar situation comes up.

EXISTING SKILLS (do not duplicate these):
${existingNames || '  (none yet)'}

COMPLETED TASKS:
${taskBlocks}

Instructions:
- Only propose a skill for a task whose steps represent a REPEATABLE procedure — something likely to recur (e.g. "restart a stuck pod after a storage remount", "rotate an expiring cert-manager secret"). Skip one-off, task-specific, or trivial work.
- Do not propose a skill that duplicates or near-duplicates an existing skill above.
- Steps must be generalized (no task-specific IDs, names, or timestamps) so they apply to future similar situations. Max ${MAX_STEPS} steps, each under ${MAX_STEP_LEN} characters.
- trigger_patterns should be short, SPECIFIC phrases (at least ${MIN_TRIGGER_PATTERN_LEN} characters, max ${MAX_TRIGGER_PATTERNS} patterns) a human or agent might type that should surface this skill — never a broad/generic word, since a match auto-injects this skill's instructions into that chat turn.

Respond with a JSON array (and nothing else) of skill definitions:
{
  "task_index": <1-based index of the task this came from>,
  "name": "short kebab-case identifier",
  "description": "one-sentence summary",
  "trigger_patterns": ["phrase one", "phrase two"],
  "steps": ["step 1", "step 2", "..."]
}

If none of the tasks are worth generalizing into a skill, return an empty array: []`

  let proposed: Array<{ task_index: number; name: string; description: string; trigger_patterns: string[]; steps: string[] }> = []
  try {
    const raw = (await callLLM(craftingPrompt, 'skill_crafting')).text
    const jsonMatch = raw.match(/\[[\s\S]*\]/)
    if (jsonMatch) proposed = JSON.parse(jsonMatch[0])
  } catch (e) {
    console.error('[dream] Skill crafting LLM/parse error:', e)
  }

  console.log(`[dream] Skill crafting — proposing ${proposed.length} skill(s) from ${tasks.length} task(s)`)

  const dreamAgentId = await getDreamAgentId()
  let written = 0
  for (const item of proposed) {
    if (!item.name?.trim() || !item.steps?.length) continue
    const task = tasks[item.task_index - 1]
    if (!task) continue

    const environmentId = taskEnvIds.get(task.id)
    if (!environmentId) continue // no environment link for the completing agent — can't scope a skill

    const prompt = item.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')
    const contentError = validateSkillContent(item.trigger_patterns, prompt, item.steps)
    if (contentError) {
      console.warn(`[dream] Skipping proposed skill "${item.name}" — ${contentError}`)
      continue
    }

    try {
      const existing = await prisma.nebulaInstance.findUnique({
        where: { environmentId_name: { environmentId, name: item.name.trim() } },
      })
      if (existing) continue // don't clobber — the crafting prompt already tries to avoid this

      const spec: SkillSpec = {
        description: item.description,
        triggerPatterns: item.trigger_patterns ?? [],
        steps: item.steps,
        systemPrompt: prompt,
      }

      const createdSkill = await prisma.nebulaInstance.create({
        data: {
          environmentId,
          name: item.name.trim(),
          category: 'skill',
          spec: JSON.stringify(spec),
          isInstalled: true,
          source: 'dream',
          createdByAgentId: dreamAgentId,
        },
      })
      // Embed for semantic trigger matching — non-fatal. Attributed to Dream's
      // own budget, same as its note embeddings.
      await embedSkill({
        id: createdSkill.id,
        name: createdSkill.name,
        description: item.description,
        triggerPatterns: item.trigger_patterns,
      }, { attributeToDream: true }).catch(() => {})
      written++
    } catch (e: unknown) {
      if ((e as { code?: string })?.code === 'P2002') continue // concurrent duplicate — not an error
      console.error('[dream] Failed to write skill:', item.name, e)
    }
  }

  // BLOCKER fix (mirrors the same fix in runExtraction): only advance the
  // watermark to now() when the batch wasn't full — otherwise tasks beyond
  // SKILL_CRAFTING_BATCH would be permanently skipped, since the next run's
  // `updatedAt: { gt: lastRun }` filter would never see them again.
  const watermark = tasks.length === SKILL_CRAFTING_BATCH
    ? tasks[tasks.length - 1].updatedAt
    : now
  await setSetting('dream.skillCraftingLastRun', String(watermark.getTime()))
  console.log(`[dream] Skill crafting complete — wrote ${written}/${proposed.length} skills (processed through ${watermark.toISOString()})`)
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

let extractionTimer:    ReturnType<typeof setTimeout> | null = null
let synthesisTimer:     ReturnType<typeof setTimeout> | null = null
let pruningTimer:       ReturnType<typeof setTimeout> | null = null
let skillCraftingTimer: ReturnType<typeof setTimeout> | null = null

export function startDream(): void {
  console.log('[dream] Starting memory consolidation scheduler')

  async function scheduleExtraction() {
    const lastRunStr = await getSetting('dream.extractionLastRun').catch(() => null)
    const lastRun    = lastRunStr ? parseInt(lastRunStr, 10) : 0
    const nextRun    = lastRun + EXTRACTION_INTERVAL_MS
    const delay      = Math.max(0, nextRun - Date.now())

    console.log(`[dream] Next extraction in ${Math.round(delay / 60000)} min`)
    extractionTimer = setTimeout(async () => {
      await runExtraction().catch(e => console.error('[dream] Extraction failed:', e))
      scheduleExtraction()
    }, delay)
  }

  async function scheduleSynthesis() {
    const lastRunStr = await getSetting('dream.synthesisLastRun').catch(() => null)
    const lastRun    = lastRunStr ? parseInt(lastRunStr, 10) : 0
    const nextRun    = lastRun + SYNTHESIS_INTERVAL_MS
    const delay      = Math.max(0, nextRun - Date.now())

    console.log(`[dream] Next synthesis in ${Math.round(delay / 60000)} min`)
    synthesisTimer = setTimeout(async () => {
      await runSynthesis().catch(e => console.error('[dream] Synthesis failed:', e))
      scheduleSynthesis()
    }, delay)
  }

  async function schedulePruning() {
    const lastRunStr = await getSetting('dream.pruningLastRun').catch(() => null)
    const lastRun    = lastRunStr ? parseInt(lastRunStr, 10) : 0
    const nextRun    = lastRun + PRUNING_INTERVAL_MS
    const delay      = Math.max(0, nextRun - Date.now())

    console.log(`[dream] Next pruning in ${Math.round(delay / 60000)} min`)
    pruningTimer = setTimeout(async () => {
      await runPruning().catch(e => console.error('[dream] Pruning failed:', e))
      schedulePruning()
    }, delay)
  }

  async function scheduleSkillCrafting() {
    const lastRunStr = await getSetting('dream.skillCraftingLastRun').catch(() => null)
    const lastRun    = lastRunStr ? parseInt(lastRunStr, 10) : 0
    const nextRun    = lastRun + SKILL_CRAFTING_INTERVAL_MS
    const delay      = Math.max(0, nextRun - Date.now())

    console.log(`[dream] Next skill crafting in ${Math.round(delay / 60000)} min`)
    skillCraftingTimer = setTimeout(async () => {
      await runSkillCrafting().catch(e => console.error('[dream] Skill crafting failed:', e))
      scheduleSkillCrafting()
    }, delay)
  }

  scheduleExtraction()
  scheduleSynthesis()
  schedulePruning()
  scheduleSkillCrafting()
}

export function stopDream(): void {
  if (extractionTimer)    clearTimeout(extractionTimer)
  if (synthesisTimer)     clearTimeout(synthesisTimer)
  if (pruningTimer)       clearTimeout(pruningTimer)
  if (skillCraftingTimer) clearTimeout(skillCraftingTimer)
}
