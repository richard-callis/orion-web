/**
 * Dream — memory consolidation for ORION.
 *
 * Two phases, run on separate schedules:
 *
 * 1. EXTRACTION (every 2 hours)
 *    Scans recent chat messages and task events since the last run.
 *    Sends batches to an LLM to extract durable facts, lessons, and patterns.
 *    Writes each extracted item as a Note + immediately embeds it.
 *
 * 2. PRUNING (every 24 hours)
 *    Reads all notes in the knowledge base.
 *    Sends each note to an LLM with recent system context.
 *    Deletes notes the LLM marks as stale or superseded.
 *
 * Last-run timestamps are stored in SystemSetting:
 *   dream.extractionLastRun  — unix ms
 *   dream.pruningLastRun     — unix ms
 */

import { prisma } from './db'
import { embedNote } from './embeddings'

// ── Config ────────────────────────────────────────────────────────────────────

const EXTRACTION_INTERVAL_MS = 2  * 60 * 60 * 1000  // 2 hours
const PRUNING_INTERVAL_MS    = 24 * 60 * 60 * 1000  // 24 hours
const EXTRACTION_BATCH       = 80   // messages per LLM call
const PRUNING_BATCH          = 20   // notes per pruning LLM call
const MAX_NOTE_AGE_DAYS      = 90   // never auto-delete notes newer than this

// ── LLM routing ───────────────────────────────────────────────────────────────
// dream.model SystemSetting controls which model runs dream. Falls back to
// ai.default-model, then falls back again if the specified model errors.

async function getDreamModelId(): Promise<string> {
  const dreamModel = await prisma.systemSetting.findUnique({ where: { key: 'dream.model' } })
  if (dreamModel?.value) return dreamModel.value

  // Fall back to system default
  const { getDefaultModelId } = await import('./default-model')
  return getDefaultModelId()
}

async function callWithModel(modelId: string, prompt: string): Promise<string> {
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
    const json = await res.json() as { text?: string }
    return json.text ?? ''
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
    const data = await res.json() as { response?: string }
    return data.response?.trim() ?? ''
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
  const data = await res.json() as { choices?: Array<{ message: { content: string } }> }
  return data.choices?.[0]?.message?.content?.trim() ?? ''
}

async function callLLM(prompt: string): Promise<string> {
  const modelId = await getDreamModelId()

  try {
    return await callWithModel(modelId, prompt)
  } catch (primaryErr) {
    console.warn(`[dream] Model '${modelId}' failed (${primaryErr}), falling back to system default`)

    const { getDefaultModelId } = await import('./default-model')
    const defaultId = await getDefaultModelId()

    if (defaultId === modelId) throw primaryErr  // same model, don't retry

    return await callWithModel(defaultId, prompt)
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getSetting(key: string): Promise<string | null> {
  return prisma.systemSetting.findUnique({ where: { key } })
    .then(r => r?.value ?? null)
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

  const corpus = [...messageLines, ...eventLines].join('\n').slice(0, 12_000)

  const extractionPrompt = `You are a memory consolidation system for an AI agent team managing a Kubernetes homelab cluster.

Review the following recent agent messages and task events, then extract durable facts, lessons, and patterns worth remembering for future tasks.

CONTENT:
${corpus}

Instructions:
- Extract only DURABLE items: things that will still be true next week (cluster quirks, known patterns, successful approaches, failure root causes, service configurations).
- Skip transient state: "pod is running now", "task assigned", routine status updates.
- Skip anything too vague to be actionable.
- Each memory must be self-contained and searchable.

Respond with a JSON array (and nothing else). Each item:
{
  "title": "short searchable title including domain/service name",
  "content": "## Context\\n...\\n## Lesson\\n...\\n## Rules for Next Time\\n- ...",
  "folder": "Success Patterns" | "Failure Patterns" | "Cluster Quirks" | "Tool Usage" | "Agent Lessons",
  "tags": ["tag1", "tag2"]
}

If nothing is worth remembering, return an empty array: []`

  let extracted: Array<{ title: string; content: string; folder: string; tags: string[] }> = []
  try {
    const raw = await callLLM(extractionPrompt)
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
      const existing = await prisma.note.findFirst({ where: { title: item.title.trim() } })
      let note: { id: string; title: string; content: string }

      if (existing) {
        // Append new information rather than overwrite
        const merged = existing.content + '\n\n---\n*Updated by dream consolidation*\n' + item.content
        note = await prisma.note.update({
          where: { id: existing.id },
          data: { content: merged, updatedAt: new Date() },
        })
      } else {
        note = await prisma.note.create({
          data: {
            title:   item.title.trim(),
            content: item.content.trim(),
            folder:  item.folder ?? 'Agent Lessons',
            type:    'note',
            tags:    (item.tags ?? []) as any,
          },
        })
      }

      await embedNote(note).catch(() => {})
      written++
    } catch (e) {
      console.error('[dream] Failed to write memory:', item.title, e)
    }
  }

  await setSetting('dream.extractionLastRun', String(now.getTime()))
  console.log(`[dream] Extraction complete — wrote ${written}/${extracted.length} memories`)
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
      const raw = await callLLM(prunePrompt)
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

// ── Scheduler ─────────────────────────────────────────────────────────────────

let extractionTimer: ReturnType<typeof setTimeout> | null = null
let pruningTimer:    ReturnType<typeof setTimeout> | null = null

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

  scheduleExtraction()
  schedulePruning()
}

export function stopDream(): void {
  if (extractionTimer) clearTimeout(extractionTimer)
  if (pruningTimer)    clearTimeout(pruningTimer)
}
