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
 *    Takes notes no hub links yet, in small batches by folder (dream-synthesis.ts).
 *    Asks an LLM to extend hubs or propose missing mid-level "hub" notes that connect
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
import { embedNote, computeSemanticEdges, embedSkill, hybridSearch } from './embeddings'
import { estimateTokens } from './token-budget'
import { completeOnce, claudeTarget, targetForExternalModel } from './agent-runner/engine/complete'
import { ProviderHttpError } from './agent-runner/engine/types'
import {
  SYNTHESIS_MAX_NEW_HUBS,
  SYNTHESIS_MAX_TOKENS,
  SYNTHESIS_SCHEMA,
  isDreamHub,
  isHub,
  linkedTitles,
  mergeHub,
  parseHubs,
  renderHub,
  synthesisBatches,
  synthesisPrompt,
  type ProposedHub,
} from './dream-synthesis'
import {
  type SkillSpec,
  validateSkillContent,
  validateSkillName,
  validateSkillDescription,
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
// Wikilink candidates shown to the extraction LLM: the notes most relevant to
// this batch plus the most recently updated ones. Listing every title made the
// prompt grow without bound as the knowledge base grew.
const EXTRACTION_RELEVANT_TITLES = 40
const EXTRACTION_RECENT_TITLES   = 100
// Retry backoff after a failed phase run: 5 min, 10, 20 … capped at 2 hours.
// Without it a failing phase (DB down, LLM down) left lastRun unchanged, so the
// next delay computed to 0 and the scheduler spun in a tight loop.
const DREAM_MIN_FAILURE_DELAY_MS = 5 * 60 * 1000
const DREAM_MAX_FAILURE_DELAY_MS = 2 * 60 * 60 * 1000
const PRUNING_BATCH          = 20   // notes per pruning LLM call
const SYNTHESIS_MAX_CALL_ERRORS = 2 // failed model calls in a row before a synthesis run stops
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
  truncated?: true
}

interface LLMCallOptions {
  /** Output token limit. */
  maxTokens?: number
  /**
   * No reasoning trace, and a JSON schema the reply must match. An endpoint that
   * rejects these fields (or the token limit) is asked again as before: plain,
   * with no limit.
   */
  direct?: { schema: Record<string, unknown> }
}

/** Statuses servers answer unknown or unsupported request fields with. */
const FIELD_REJECTED = [400, 422, 500, 501]

function directBody(direct: NonNullable<LLMCallOptions['direct']>, ollama: boolean): Record<string, unknown> {
  if (ollama) return { think: false, format: direct.schema }
  return {
    chat_template_kwargs: { enable_thinking: false },  // llama.cpp, vLLM, SGLang
    response_format: { type: 'json_schema', json_schema: { name: 'reply', schema: direct.schema } },
  }
}

/** @internal exported for the engine characterization tests */
export async function callWithModel(modelId: string, prompt: string, opts: LLMCallOptions = {}): Promise<LLMCallResult> {
  const claude = claudeTarget(modelId)
  if (claude) {
    const r = await completeOnce(claude, prompt, { timeoutMs: 90_000 })
    // The sidecar doesn't reliably report usage — fall back to a length-based
    // estimate (input from the prompt, since the sidecar never echoes it).
    return { text: r.text, inputTokens: r.inputTokens ?? estimateTokens(prompt), outputTokens: r.outputTokens ?? estimateTokens(r.text) }
  }

  // External model (OpenAI-compatible or Ollama)
  const extModel = await prisma.externalModel.findUnique({ where: { id: modelId } })
  if (!extModel) throw new Error(`dream.model '${modelId}' not found`)

  const isOllama = extModel.provider === 'ollama'
  const target = targetForExternalModel(extModel)
  const timeoutMs = isOllama ? 90_000 : (extModel.timeoutSecs ?? 120) * 1000
  const maxTokens = opts.maxTokens === undefined ? undefined : Math.min(opts.maxTokens, extModel.maxTokens ?? Infinity)
  const extra = {
    ...(maxTokens !== undefined && { maxTokens }),
    ...(opts.direct && { extraBody: directBody(opts.direct, isOllama) }),
  }
  let r
  try {
    try {
      r = await completeOnce(target, prompt, { timeoutMs, ...extra })
    } catch (e) {
      if (Object.keys(extra).length === 0 || !(e instanceof ProviderHttpError) || !FIELD_REJECTED.includes(e.status)) throw e
      console.warn(`[dream] Model '${modelId}' rejected the request with extra fields (HTTP ${e.status}: ${e.body.slice(0, 200)}); retrying without them`)
      r = await completeOnce(target, prompt, { timeoutMs })
    }
  } catch (e) {
    if (e instanceof ProviderHttpError) throw new Error(`${isOllama ? 'Ollama' : 'External model'} HTTP ${e.status}`, { cause: e })
    throw e
  }
  return {
    text: r.text,
    inputTokens: r.inputTokens ?? estimateTokens(prompt),
    outputTokens: r.outputTokens ?? estimateTokens(r.text),
    ...(r.reasoning && { reasoning: r.reasoning }),
    ...(r.truncated && { truncated: true as const }),
  }
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
  truncated?: true
}

async function callLLM(prompt: string, jobType: 'extraction' | 'synthesis' | 'pruning' | 'skill_crafting', opts: LLMCallOptions = {}): Promise<DreamLLMResult> {
  const modelId = await getDreamModelId()

  try {
    const result = await callWithModel(modelId, prompt, opts)
    await recordDreamUsage(result.inputTokens, result.outputTokens, modelId)
    if (!result.truncated) await recordDreamReasoning(jobType, result.reasoning)
    return { text: result.text, reasoning: result.reasoning, truncated: result.truncated }
  } catch (primaryErr) {
    const { getDefaultModelId } = await import('./default-model')
    const defaultId = await getDefaultModelId()

    if (defaultId === modelId) {  // same model, don't retry
      console.warn(`[dream] Model '${modelId}' failed (${primaryErr}); it is the system default, so there is nothing to fall back to`)
      throw primaryErr
    }
    console.warn(`[dream] Model '${modelId}' failed (${primaryErr}), falling back to system default`)

    const result = await callWithModel(defaultId, prompt, opts)
    await recordDreamUsage(result.inputTokens, result.outputTokens, defaultId)
    if (!result.truncated) await recordDreamReasoning(jobType, result.reasoning)
    return { text: result.text, reasoning: result.reasoning, truncated: result.truncated }
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
 * Latest timestamp that is safe to process when several sources were each
 * fetched with their own `take`. A source that returned exactly `limit` rows
 * may have more rows after its last one, so processing must stop there.
 * Returns null when no source was truncated (everything fetched is safe).
 */
export function combinedHorizon(sources: Array<{ rows: Array<{ ts: Date }>; limit: number }>): Date | null {
  let horizon: Date | null = null
  for (const { rows, limit } of sources) {
    if (rows.length < limit || rows.length === 0) continue
    const last = rows[rows.length - 1].ts
    if (horizon === null || last.getTime() < horizon.getTime()) horizon = last
  }
  return horizon
}

/** Titles the extraction LLM may [[wikilink]] to: relevant to this batch + recent. */
async function wikilinkCandidateTitles(corpus: string): Promise<string> {
  const seen = new Set<string>()
  const lines: string[] = []
  const add = (title: string, folder: string | null) => {
    if (seen.has(title)) return
    seen.add(title)
    lines.push(`  - ${title} (${folder ?? 'Notes'})`)
  }
  try {
    const { hits } = await hybridSearch(corpus, EXTRACTION_RELEVANT_TITLES)
    for (const h of hits) add(h.title, h.folder)
  } catch (e) {
    console.warn('[dream] Relevant-title search failed, using recent titles only:', e)
  }
  const recent = await prisma.note.findMany({
    select: { title: true, folder: true },
    orderBy: { updatedAt: 'desc' },
    take: EXTRACTION_RECENT_TITLES,
  })
  for (const n of recent) add(n.title, n.folder)
  return lines.join('\n')
}

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

  // Build text corpus rows for the LLM
  const messageRows = messages.map(m => {
    const who    = m.agent?.name ?? m.senderType
    const attach = m.attachments as Record<string, string> | null
    const body   = attach?.output ?? m.content ?? ''
    return { ts: m.createdAt, line: `[${who}] ${body.slice(0, 400)}` }
  })

  const eventRows = events.map(e => {
    const task = e.task?.title ? `(task: ${e.task.title}) ` : ''
    return { ts: e.createdAt, line: `[${e.eventType}] ${task}${(e.content ?? '').slice(0, 400)}` }
  })

  // Page both sources by ONE combined cursor. Each query has its own `take`, so
  // when one source is truncated the other may extend past it — merging both
  // and advancing the watermark to the later timestamp would permanently skip
  // the truncated source's unfetched rows. Only rows up to the earliest
  // truncation point are safe to process this run.
  const horizon = combinedHorizon([
    { rows: messageRows, limit: EXTRACTION_BATCH * 3 },
    { rows: eventRows,   limit: EXTRACTION_BATCH * 2 },
  ])

  // BLOCKER fix: build corpus with a budget and track the watermark to only the
  // last row that actually fit. Previously: all rows were fetched, corpus was
  // blindly sliced to 12k, but watermark advanced to now() unconditionally —
  // content past the 12k cut was permanently skipped on the next run.
  const allRows = [...messageRows, ...eventRows]
    .filter(r => horizon === null || r.ts.getTime() <= horizon.getTime())
    .sort((a, b) => a.ts.getTime() - b.ts.getTime())

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

  const existingTitles = await wikilinkCandidateTitles(corpus)

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

  // An LLM failure propagates: the watermark is NOT advanced, so this window is
  // retried (with backoff) instead of being silently skipped. A response that
  // arrives but can't be parsed is logged and the window is consumed — retrying
  // the same prompt would most likely fail the same way forever.
  const raw = (await callLLM(extractionPrompt, 'extraction')).text
  let extracted: Array<{ title: string; content: string; folder: string; tags: string[] }> = []
  try {
    const jsonMatch = raw.match(/\[[\s\S]*\]/)
    if (jsonMatch) extracted = JSON.parse(jsonMatch[0])
  } catch (e) {
    console.error('[dream] Extraction parse error (window consumed):', e)
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

      const embedded = await embedNote(note, { attributeToDream: true }).catch(e => { console.error(`[dream] embedNote failed for "${note.title}":`, e); return false })
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
 * Identify missing hub notes that should connect clusters of related specifics,
 * batch by batch over the notes no hub links yet, at most SYNTHESIS_MAX_NEW_HUBS
 * new ones per run. Hubs [[wikilink]] to their members — giving the knowledge
 * graph real structure. Existing hubs only ever gain links.
 * Called every SYNTHESIS_INTERVAL_MS.
 */
export async function runSynthesis(): Promise<void> {
  const lastRunStr = await getSetting('dream.synthesisLastRun')
  const lastRun    = lastRunStr ? new Date(parseInt(lastRunStr, 10)) : new Date(0)
  const now        = new Date()

  console.log(`[dream] Synthesis — last run ${lastRun.toISOString()}`)

  const notes = await prisma.note.findMany({
    select: { title: true, folder: true, tags: true, content: true },
    orderBy: { updatedAt: 'desc' },
  })

  if (notes.length < 5) {
    console.log('[dream] Synthesis — not enough notes yet, skipping')
    await setSetting('dream.synthesisLastRun', String(now.getTime()))
    return
  }

  const hubNotes = notes.filter(n => isHub(n.tags))
  const batches = synthesisBatches(notes, linkedTitles(notes.map(n => n.title), hubNotes.map(n => n.content)))
  // Only Dream's own hubs may be extended, so only they are offered by title.
  const hubTitles = notes.filter(n => isDreamHub(n.tags)).map(n => n.title.trim())
  let created = 0, extended = 0, replies = 0, unusable = 0, failed = 0, callErrors = 0
  let lastError: unknown

  for (const [i, batch] of batches.entries()) {
    if (created >= SYNTHESIS_MAX_NEW_HUBS) break // the rest waits for the next run
    let reply: DreamLLMResult
    try {
      reply = await callLLM(synthesisPrompt(batch, hubTitles), 'synthesis', {
        maxTokens: SYNTHESIS_MAX_TOKENS,
        direct: { schema: SYNTHESIS_SCHEMA },
      })
    } catch (e) {
      callErrors++
      failed++
      lastError = e
      console.error(`[dream] Synthesis batch ${i + 1}/${batches.length} failed (${batch.length} notes):`, e)
      if (callErrors >= SYNTHESIS_MAX_CALL_ERRORS) break // the model is down or far too slow: don't wait it out per batch
      continue
    }
    replies++
    callErrors = 0
    let hubs: ProposedHub[]
    try {
      if (reply.truncated) throw new Error('reply cut off at the token limit')
      hubs = parseHubs(reply.text, batch, hubTitles)
    } catch (e) {
      unusable++
      console.error(`[dream] Synthesis batch ${i + 1}/${batches.length}: unusable reply (${batch.length} notes):`, e)
      continue
    }
    for (const hub of hubs) {
      if (created >= SYNTHESIS_MAX_NEW_HUBS) break
      try {
        const result = await writeHub(hub)
        if (result === 'created') created++
        if (result === 'extended') extended++
        // Later batches may add to it, unless it turned out not to be a hub.
        if (result !== 'refused' && !hubTitles.includes(hub.title)) hubTitles.unshift(hub.title)
      } catch (e) {
        console.error('[dream] Failed to write hub note:', hub.title, e)
      }
    }
  }

  // The model never answered: no watermark advance, so it is retried with backoff.
  // An unusable answer consumes the run (the same prompt would get it again, at
  // full price); those notes are simply part of the next one.
  if (replies === 0 && failed > 0) throw lastError

  await setSetting('dream.synthesisLastRun', String(now.getTime()))
  console.log(`[dream] Synthesis complete — ${created} new, ${extended} extended hub notes; ${replies}/${batches.length} batches answered (${unusable} unusable, ${failed} failed)`)
}

/** Create a hub note, or add missing links to the existing one. */
async function writeHub(hub: ProposedHub): Promise<'created' | 'extended' | 'unchanged' | 'refused'> {
  // Only dream-owned notes are ever touched: a title shared with a human note
  // makes a new note. A dream note of that title that isn't a hub (a specific
  // note) is left alone too.
  const existing =
    await prisma.note.findFirst({ where: { title: hub.title, tags: { array_contains: ['dream', 'hub'] } } }) ??
    await prisma.note.findFirst({ where: { title: hub.title, tags: { array_contains: ['dream'] } } })
  if (existing && !isHub(existing.tags)) {
    console.warn(`[dream] Synthesis — "${hub.title}" is already a specific note, not replaced`)
    return 'refused'
  }
  let note
  if (existing) {
    const content = mergeHub(existing.content, hub)
    if (content === null) return 'unchanged'
    note = await prisma.note.update({ where: { id: existing.id }, data: { content, updatedAt: new Date() } })
  } else {
    note = await prisma.note.create({
      data: { title: hub.title, content: renderHub(hub), folder: hub.folder, type: 'note', tags: ['dream', 'hub'] },
    })
  }
  const embedded = await embedNote(note, { attributeToDream: true }).catch(e => { console.error(`[dream] embedNote failed for "${note.title}":`, e); return false })
  if (embedded) await computeSemanticEdges(note.id).catch(() => {})
  return existing ? 'extended' : 'created'
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
  let llmFailures = 0
  const batchCount = Math.ceil(notes.length / PRUNING_BATCH)
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

    let raw: string
    try {
      raw = (await callLLM(prunePrompt, 'pruning')).text
    } catch (e) {
      llmFailures++
      console.error('[dream] Pruning LLM error:', e)
      continue
    }
    try {
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

  // Every batch failed at the LLM → nothing was actually reviewed; don't mark
  // the run done so it retries with backoff.
  if (batchCount > 0 && llmFailures === batchCount) {
    throw new Error(`Pruning: all ${batchCount} LLM batch call(s) failed`)
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

  // LLM failure propagates (no watermark advance → retried with backoff);
  // an unparseable response is logged and the batch is consumed.
  const raw = (await callLLM(craftingPrompt, 'skill_crafting')).text
  let proposed: Array<{ task_index: number; name: string; description: string; trigger_patterns: string[]; steps: string[] }> = []
  try {
    const jsonMatch = raw.match(/\[[\s\S]*\]/)
    if (jsonMatch) proposed = JSON.parse(jsonMatch[0])
  } catch (e) {
    console.error('[dream] Skill crafting parse error (batch consumed):', e)
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

    const skillName = item.name.trim()
    // The LLM proposal is synthesized from task events, which can embed
    // externally-controlled text (issue bodies, webhook payloads, cluster
    // logs) — same interpolation risk as the agent self-save path, so it's
    // held to the exact same name/description validation before it's ever
    // stored or later interpolated into another agent's system prompt.
    const nameError = validateSkillName(skillName)
    if (nameError) {
      console.warn(`[dream] Skipping proposed skill "${item.name}" — ${nameError}`)
      continue
    }
    const descriptionError = validateSkillDescription(item.description)
    if (descriptionError) {
      console.warn(`[dream] Skipping proposed skill "${skillName}" — ${descriptionError}`)
      continue
    }

    const prompt = item.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')
    const contentError = validateSkillContent(item.trigger_patterns, prompt, item.steps)
    if (contentError) {
      console.warn(`[dream] Skipping proposed skill "${item.name}" — ${contentError}`)
      continue
    }

    try {
      const existing = await prisma.nebulaInstance.findUnique({
        where: { environmentId_name: { environmentId, name: skillName } },
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
          name: skillName,
          category: 'skill',
          spec: JSON.stringify(spec),
          // Dream synthesizes this from task event content, which can
          // include externally-controlled text (GitHub issue bodies,
          // webhook payloads, cluster logs fed through tool_call/
          // tool_result/agent_output events). Auto-installing (isInstalled:
          // true) would mean untrusted content gets immediately and
          // automatically injected into every future matching turn for
          // every agent in the environment — a prompt-injection persistence
          // path. Dream-crafted skills therefore land pending human review;
          // an operator/admin must explicitly install them (PUT
          // /api/environments/[id]/nebula/[name] with { isInstalled: true },
          // also wired up as a toggle in the Nebula UI's Settings tab)
          // before they can auto-inject or be looked up via
          // list_skills/use_skill.
          isInstalled: false,
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

/**
 * Delay until a phase's next run. After a failure the phase's lastRun has not
 * advanced, so the interval-based delay would be 0 — use exponential backoff
 * instead so a persistent failure can't turn into a hot loop.
 */
export function computeDreamDelay(
  lastRunMs: number,
  intervalMs: number,
  consecutiveFailures: number,
  nowMs: number = Date.now(),
): number {
  if (consecutiveFailures > 0) {
    const backoff = DREAM_MIN_FAILURE_DELAY_MS * Math.pow(2, consecutiveFailures - 1)
    return Math.min(DREAM_MAX_FAILURE_DELAY_MS, backoff)
  }
  return Math.max(0, lastRunMs + intervalMs - nowMs)
}

const dreamTimers = new Map<string, ReturnType<typeof setTimeout>>()
let dreamStopped = false

function scheduleDreamPhase(
  name: string,
  settingKey: string,
  intervalMs: number,
  run: () => Promise<void>,
  consecutiveFailures = 0,
): void {
  if (dreamStopped) return
  getSetting(settingKey)
    .catch(() => null)
    .then(lastRunStr => {
      if (dreamStopped) return
      const lastRun = lastRunStr ? parseInt(lastRunStr, 10) || 0 : 0
      const delay = computeDreamDelay(lastRun, intervalMs, consecutiveFailures)
      console.log(`[dream] Next ${name} in ${Math.round(delay / 60000)} min${consecutiveFailures ? ` (retry #${consecutiveFailures})` : ''}`)
      dreamTimers.set(name, setTimeout(async () => {
        let failures = 0
        try {
          await run()
        } catch (e) {
          failures = consecutiveFailures + 1
          console.error(`[dream] ${name} failed (attempt ${failures}):`, e)
        }
        scheduleDreamPhase(name, settingKey, intervalMs, run, failures)
      }, delay))
    })
}

export function startDream(): void {
  console.log('[dream] Starting memory consolidation scheduler')
  dreamStopped = false
  scheduleDreamPhase('extraction',     'dream.extractionLastRun',    EXTRACTION_INTERVAL_MS,     runExtraction)
  scheduleDreamPhase('synthesis',      'dream.synthesisLastRun',     SYNTHESIS_INTERVAL_MS,      runSynthesis)
  scheduleDreamPhase('pruning',        'dream.pruningLastRun',       PRUNING_INTERVAL_MS,        runPruning)
  scheduleDreamPhase('skill crafting', 'dream.skillCraftingLastRun', SKILL_CRAFTING_INTERVAL_MS, runSkillCrafting)
}

export function stopDream(): void {
  dreamStopped = true
  for (const t of dreamTimers.values()) clearTimeout(t)
  dreamTimers.clear()
}
