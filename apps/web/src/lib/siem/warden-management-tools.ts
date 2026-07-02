/**
 * Warden SIEM management tools.
 *
 * These tools let Warden — ORION's AI security analyst — operate on incidents and
 * investigations directly via Prisma (server-side, no HTTP) during the security-room
 * reply loop triggered by the correlator.
 *
 * The investigation case-management primitives (investigation_create, observable_add,
 * investigation_note, timeline_add, investigation_link_incident) already exist in
 * tool-registry.ts. This module adds the two incident-facing tools that were missing —
 * reading full incident detail and transitioning incident status — plus thin,
 * explicitly-named `siem_*` wrappers around the investigation primitives so Warden's
 * triage workflow reads as a single coherent toolset.
 *
 * SOC2 [A-001]: all writes are attributed to "warden" and mirrored to the
 * investigation timeline / audit trail where applicable.
 */

import { z } from 'zod'
import { prisma } from '@/lib/db'
import { registerTool, type ToolExecutionContext } from '@/lib/tool-registry'

// Incident status lifecycle — forward-only transitions enforced by siem_update_incident_status.
const INCIDENT_STATUS_ORDER = ['open', 'triaged', 'contained', 'closed'] as const
type IncidentStatus = (typeof INCIDENT_STATUS_ORDER)[number]

const OBSERVABLE_CATEGORIES = [
  'ipv4', 'ipv6', 'domain', 'url', 'file_hash_md5', 'file_hash_sha1', 'file_hash_sha256',
  'mac_address', 'email', 'username', 'file_path', 'registry_key', 'mutex', 'asn',
] as const

const OBSERVABLE_VERDICTS = ['malicious', 'suspicious', 'benign', 'unknown'] as const

// ── Zod schemas ─────────────────────────────────────────────────────────────

const getIncidentSchema = z.object({
  incidentId: z.string().min(1, 'incidentId is required'),
})

const createInvestigationSchema = z.object({
  incidentId: z.string().min(1, 'incidentId is required'),
  title: z.string().min(1, 'title is required'),
  severity: z.number().int().min(0).max(100),
})

const addObservableSchema = z.object({
  investigationId: z.string().min(1, 'investigationId is required'),
  value: z.string().min(1, 'value is required'),
  category: z.enum(OBSERVABLE_CATEGORIES),
  verdict: z.enum(OBSERVABLE_VERDICTS).optional(),
  confidence: z.number().int().min(0).max(100).optional(),
  context: z.string().optional(),
})

const addNoteSchema = z.object({
  investigationId: z.string().min(1, 'investigationId is required'),
  content: z.string().min(1, 'content is required'),
})

const updateIncidentStatusSchema = z.object({
  incidentId: z.string().min(1, 'incidentId is required'),
  status: z.enum(['triaged', 'contained', 'closed']),
  rootCauseSummary: z.string().optional(),
})

const addTimelineEntrySchema = z.object({
  investigationId: z.string().min(1, 'investigationId is required'),
  title: z.string().min(1, 'title is required'),
  eventType: z.string().min(1, 'eventType is required'),
})

const requestContainmentSchema = z.object({
  incidentId:    z.string().min(1, 'incidentId is required'),
  action:        z.string().min(1, 'action is required'),
  justification: z.string().min(1, 'justification is required'),
})

const checkContainmentStatusSchema = z.object({
  requestId: z.string().min(1, 'requestId is required'),
})

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatZodError(err: z.ZodError): string {
  return 'Error: ' + err.issues.map(i => i.message).join('; ')
}

/**
 * Verify that ctx.agentId belongs to the Warden agent. Write tools call this before
 * mutating SIEM data to prevent non-Warden agents from operating on incidents.
 * Returns a denial error string if the check fails, or null if the caller is Warden.
 *
 * We order by id asc to always resolve the original seeded Warden agent rather
 * than a later impostor that happens to share the same name. Agent IDs are CUIDs
 * which embed a timestamp and are lexicographically monotone, so the earliest ID
 * corresponds to the first-created (legitimate) Warden record.
 */
async function requireWardenAgent(ctx: ToolExecutionContext): Promise<string | null> {
  const warden = await prisma.agent.findFirst({
    where: { name: 'Warden' },
    orderBy: { id: 'asc' },
    select: { id: true },
  })
  if (!warden) return `Error: Warden agent not found — this tool is restricted to the Warden agent`
  if (ctx.agentId !== warden.id) return `Error: this tool is restricted to the Warden agent. Caller agentId: ${ctx.agentId ?? 'none'}`
  return null
}

// ── Handlers ────────────────────────────────────────────────────────────────

async function siemGetIncident(args: unknown, _ctx: ToolExecutionContext): Promise<string> {
  const parsed = getIncidentSchema.safeParse(args)
  if (!parsed.success) return formatZodError(parsed.error)

  const incident = await prisma.incident.findUnique({
    where: { id: parsed.data.incidentId },
    include: {
      events: { take: 20, orderBy: { createdAt: 'desc' } },
    },
  })
  if (!incident) return `Error: incident ${parsed.data.incidentId} not found`

  return JSON.stringify({
    id: incident.id,
    status: incident.status,
    severity: incident.severity,
    rootCauseSummary: incident.rootCauseSummary,
    attackerKey: incident.attackerKey,
    hostKey: incident.hostKey,
    openedAt: incident.openedAt,
    investigationId: incident.investigationId,
    events: incident.events.map(e => ({
      id: e.id,
      type: e.type,
      source: e.source,
      severity: e.severity,
      title: e.title,
      description: e.description,
      createdAt: e.createdAt,
    })),
  }, null, 2)
}

async function siemCreateInvestigation(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const denied = await requireWardenAgent(ctx)
  if (denied) return denied

  const parsed = createInvestigationSchema.safeParse(args)
  if (!parsed.success) return formatZodError(parsed.error)
  const { incidentId, title, severity } = parsed.data

  const incident = await prisma.incident.findUnique({ where: { id: incidentId } })
  if (!incident) return `Error: incident ${incidentId} not found`

  const investigation = await prisma.investigation.create({
    data: { name: title, severity, status: 'open', createdBy: 'warden' },
  })
  await prisma.incident.update({
    where: { id: incidentId },
    data: { investigationId: investigation.id },
  })
  await prisma.investigationTimeline.create({
    data: {
      investigationId: investigation.id,
      eventTime: new Date(),
      eventType: 'incident_created',
      title: `Investigation opened for incident ${incident.attackerKey ?? incidentId}`,
      source: 'warden',
    },
  }).catch(() => {})

  return JSON.stringify({ investigationId: investigation.id })
}

async function siemAddObservable(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const denied = await requireWardenAgent(ctx)
  if (denied) return denied

  const parsed = addObservableSchema.safeParse(args)
  if (!parsed.success) return formatZodError(parsed.error)
  const { investigationId, value, category, context } = parsed.data
  const verdict = parsed.data.verdict ?? 'unknown'
  const confidence = parsed.data.confidence ?? 0

  if (verdict === 'malicious' && confidence < 80) {
    return 'Error: confidence >= 80 required for a malicious verdict'
  }

  const setVerdict = verdict !== 'unknown'
  const observable = await prisma.investigationObservable.upsert({
    where: { investigationId_value_category: { investigationId, value, category } },
    create: {
      investigationId,
      value,
      displayValue: value,
      category,
      verdict,
      confidence,
      context: context ?? 'Added by Warden',
      ...(setVerdict ? { verdictBy: ctx.agentId ?? 'warden', verdictAt: new Date() } : {}),
    },
    update: {
      lastSeen: new Date(),
      confidence,
      ...(setVerdict ? { verdict, verdictBy: ctx.agentId ?? 'warden', verdictAt: new Date() } : {}),
      ...(context ? { context } : {}),
    },
  })

  return JSON.stringify({ observableId: observable.id })
}

async function siemAddNote(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const denied = await requireWardenAgent(ctx)
  if (denied) return denied

  const parsed = addNoteSchema.safeParse(args)
  if (!parsed.success) return formatZodError(parsed.error)
  const { investigationId, content } = parsed.data

  const investigation = await prisma.investigation.findUnique({ where: { id: investigationId } })
  if (!investigation) return `Error: investigation ${investigationId} not found`

  const note = await prisma.investigationNote.create({
    data: { investigationId, content, author: 'Warden', authorType: 'warden' },
  })
  await prisma.investigationTimeline.create({
    data: {
      investigationId,
      eventTime: new Date(),
      eventType: 'note_added',
      title: 'Warden triage note added',
      source: 'warden',
    },
  }).catch(() => {})

  return JSON.stringify({ noteId: note.id })
}

async function siemUpdateIncidentStatus(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const denied = await requireWardenAgent(ctx)
  if (denied) return denied

  const parsed = updateIncidentStatusSchema.safeParse(args)
  if (!parsed.success) return formatZodError(parsed.error)
  const { incidentId, status, rootCauseSummary } = parsed.data

  const incident = await prisma.incident.findUnique({ where: { id: incidentId } })
  if (!incident) return `Error: incident ${incidentId} not found`

  const currentIdx = INCIDENT_STATUS_ORDER.indexOf(incident.status as IncidentStatus)
  const nextIdx = INCIDENT_STATUS_ORDER.indexOf(status)
  // Reject backward or no-op transitions — the lifecycle is forward-only.
  if (currentIdx < 0) {
    return `Error: incident is in unknown status "${incident.status}" — cannot transition`
  }
  if (nextIdx <= currentIdx) {
    return `Error: cannot transition incident from "${incident.status}" to "${status}" — only forward transitions (open → triaged → contained → closed) are allowed`
  }

  const updated = await prisma.incident.update({
    where: { id: incidentId },
    data: {
      status,
      ...(rootCauseSummary ? { rootCauseSummary } : {}),
    },
  })

  return JSON.stringify({
    id: updated.id,
    status: updated.status,
    rootCauseSummary: updated.rootCauseSummary,
  })
}

async function siemAddTimelineEntry(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const denied = await requireWardenAgent(ctx)
  if (denied) return denied

  const parsed = addTimelineEntrySchema.safeParse(args)
  if (!parsed.success) return formatZodError(parsed.error)
  const { investigationId, title, eventType } = parsed.data

  const investigation = await prisma.investigation.findUnique({ where: { id: investigationId } })
  if (!investigation) return `Error: investigation ${investigationId} not found`

  const entry = await prisma.investigationTimeline.create({
    data: { investigationId, title, eventType, source: 'warden', eventTime: new Date() },
  })

  return JSON.stringify({ entryId: entry.id })
}

async function siemRequestContainment(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const denied = await requireWardenAgent(ctx)
  if (denied) return denied

  const parsed = requestContainmentSchema.safeParse(args)
  if (!parsed.success) return formatZodError(parsed.error)
  const { incidentId, action, justification } = parsed.data

  const incident = await prisma.incident.findUnique({ where: { id: incidentId } })
  if (!incident) return `Error: incident ${incidentId} not found`

  const request = await prisma.containmentRequest.create({
    data: { incidentId, action, justification, requestedBy: ctx.agentId ?? 'warden', status: 'pending' },
  })

  return JSON.stringify({ requestId: request.id, status: request.status })
}

async function siemCheckContainmentStatus(args: unknown, _ctx: ToolExecutionContext): Promise<string> {
  const parsed = checkContainmentStatusSchema.safeParse(args)
  if (!parsed.success) return formatZodError(parsed.error)

  const request = await prisma.containmentRequest.findUnique({ where: { id: parsed.data.requestId } })
  if (!request) return `Error: containment request ${parsed.data.requestId} not found`

  return JSON.stringify({
    requestId:     request.id,
    incidentId:    request.incidentId,
    action:        request.action,
    justification: request.justification,
    status:        request.status,
    requestedBy:   request.requestedBy,
    reviewedBy:    request.reviewedBy,
    reviewedAt:    request.reviewedAt,
    createdAt:     request.createdAt,
  })
}

// ── Tool definitions ─────────────────────────────────────────────────────────

export const wardenManagementTools = [
  {
    name: 'siem_get_incident',
    description: 'Fetch full detail for a security incident, including its 20 most recent linked security events. Call this first when triaging an incident.',
    inputSchema: {
      type: 'object',
      properties: {
        incidentId: { type: 'string', description: 'Incident ID to fetch' },
      },
      required: ['incidentId'],
    },
    tier: 'read' as const,
    parallelSafe: true,
    availableIn: 'chat' as const,
    category: 'security' as const,
    handler: siemGetIncident,
  },
  {
    name: 'siem_create_investigation',
    description: 'Create a new investigation case and link it to an incident. Returns { investigationId }.',
    inputSchema: {
      type: 'object',
      properties: {
        incidentId: { type: 'string', description: 'Incident the investigation is opened for' },
        title:      { type: 'string', description: 'Investigation name / title' },
        severity:   { type: 'number', description: 'Severity 0-100' },
      },
      required: ['incidentId', 'title', 'severity'],
    },
    tier: 'write' as const,
    parallelSafe: false,
    availableIn: 'chat' as const,
    category: 'security' as const,
    handler: siemCreateInvestigation,
  },
  {
    name: 'siem_add_observable',
    description: 'Add an observable (IP, domain, hash, URL, etc.) to an investigation. Malicious verdicts require confidence >= 80.',
    inputSchema: {
      type: 'object',
      properties: {
        investigationId: { type: 'string' },
        value:           { type: 'string', description: 'Observable value (e.g. 1.2.3.4, evil.com)' },
        category:        { type: 'string', enum: [...OBSERVABLE_CATEGORIES] },
        verdict:         { type: 'string', enum: [...OBSERVABLE_VERDICTS] },
        confidence:      { type: 'number', description: '0-100; must be >= 80 to mark malicious' },
        context:         { type: 'string', description: 'Where/how the observable was found' },
      },
      required: ['investigationId', 'value', 'category'],
    },
    tier: 'write' as const,
    parallelSafe: false,
    availableIn: 'chat' as const,
    category: 'security' as const,
    handler: siemAddObservable,
  },
  {
    name: 'siem_add_note',
    description: 'Add a triage note to an investigation, authored by Warden.',
    inputSchema: {
      type: 'object',
      properties: {
        investigationId: { type: 'string' },
        content:         { type: 'string', description: 'Markdown note content' },
      },
      required: ['investigationId', 'content'],
    },
    tier: 'write' as const,
    parallelSafe: false,
    availableIn: 'chat' as const,
    category: 'security' as const,
    handler: siemAddNote,
  },
  {
    name: 'siem_update_incident_status',
    description: 'Transition an incident forward through its lifecycle (open → triaged → contained → closed). Only forward transitions are allowed. Use "closed" to close a fully contained incident.',
    inputSchema: {
      type: 'object',
      properties: {
        incidentId:       { type: 'string' },
        status:           { type: 'string', enum: ['triaged', 'contained', 'closed'] },
        rootCauseSummary: { type: 'string', description: 'Optional free-text root-cause summary' },
      },
      required: ['incidentId', 'status'],
    },
    tier: 'write' as const,
    parallelSafe: false,
    availableIn: 'chat' as const,
    category: 'security' as const,
    handler: siemUpdateIncidentStatus,
  },
  {
    name: 'siem_add_timeline_entry',
    description: 'Log a timeline event on an investigation (e.g. triage complete).',
    inputSchema: {
      type: 'object',
      properties: {
        investigationId: { type: 'string' },
        title:           { type: 'string' },
        eventType:       { type: 'string', description: 'e.g. warden_annotation, status_changed, action_taken' },
      },
      required: ['investigationId', 'title', 'eventType'],
    },
    tier: 'write' as const,
    parallelSafe: false,
    availableIn: 'chat' as const,
    category: 'security' as const,
    handler: siemAddTimelineEntry,
  },
  {
    name: 'siem_request_containment',
    description: 'Request human approval to contain an incident (e.g. isolate host, block IP). Creates a pending ContainmentRequest that an admin must approve or reject. Restricted to the Warden agent. Returns { requestId, status }.',
    inputSchema: {
      type: 'object',
      properties: {
        incidentId:    { type: 'string', description: 'Incident to contain' },
        action:        { type: 'string', description: 'Proposed containment action (e.g. isolate_host, block_ip)' },
        justification: { type: 'string', description: 'Why containment is warranted' },
      },
      required: ['incidentId', 'action', 'justification'],
    },
    tier: 'write' as const,
    parallelSafe: false,
    availableIn: 'chat' as const,
    category: 'security' as const,
    handler: siemRequestContainment,
  },
  {
    name: 'siem_check_containment_status',
    description: 'Check the status (pending / approved / rejected) of a previously submitted containment request.',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', description: 'Containment request ID returned by siem_request_containment' },
      },
      required: ['requestId'],
    },
    tier: 'read' as const,
    parallelSafe: true,
    availableIn: 'chat' as const,
    category: 'security' as const,
    handler: siemCheckContainmentStatus,
  },
]

/**
 * Register all Warden SIEM tools with the unified tool registry. Called as a
 * side-effect from management-tools.ts so the tools are available wherever the
 * registry is consulted (room-agents, MCP, openai/ollama runners).
 */
export function registerWardenManagementTools(): void {
  for (const tool of wardenManagementTools) {
    registerTool({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      tier: tool.tier,
      parallelSafe: tool.parallelSafe,
      availableIn: tool.availableIn,
      // 'security' is used by the existing SOC tools via an `as any` cast — the
      // ToolCategory union does not list it. Mirror that here.
      category: tool.category as unknown as Parameters<typeof registerTool>[0]['category'],
      handler: tool.handler,
    })
  }
}
