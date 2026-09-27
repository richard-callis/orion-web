/**
 * Security / SOC tools registered so Warden can use them via MCP.
 *
 * Tool definitions only — registered (in the canonical order) by ./index.ts.
 */

import { prisma as _socPrisma } from '@/lib/db'
import type { ToolDefinition } from './registry'

function _soc<T>(args: unknown): T { return args as T }

export const securityProposeActionTool: ToolDefinition = {
  name: 'security_propose_action',
  description: 'Propose a security action (ban IP, active response, firewall block). Routes through the policy-gated action-service: auto-tier executes immediately, approve/escalate-tier queues for operator review.',
  inputSchema: {
    type: 'object',
    properties: {
      actionType: { type: 'string', enum: ['crowdsec_decision_create', 'crowdsec_decision_delete', 'wazuh_active_response', 'firewall_block', 'investigate', 'incident_close', 'suppression_add'] },
      target: { type: 'string', description: 'IP address, decision ID, agent name, or CIDR' },
      reason: { type: 'string', description: 'Why this action is proposed' },
      incidentId: { type: 'string', description: 'Incident ID this action is in response to' },
      payload: { type: 'object', description: 'Additional action parameters (duration, command, scope, etc.)' },
    },
    required: ['actionType', 'target', 'reason'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'chat',
  category: 'security',
  handler: async (args) => {
    const a = _soc<{ actionType: string; target: string; reason: string; incidentId?: string; payload?: Record<string, unknown> }>(args)
    const { decide, execute, gatewayExecutor } = await import('@/lib/security/action-service')
    const panicPolicy = await _socPrisma.actionPolicy.findUnique({ where: { actionType: '__panic_mode__' } })
    const decision = await decide({ actionType: a.actionType, target: a.target, reason: a.reason, incidentId: a.incidentId, payload: a.payload ?? null }, panicPolicy?.defaultTier === 'approve')
    const result = await execute({ actionType: a.actionType, target: a.target, reason: a.reason, incidentId: a.incidentId, payload: a.payload ?? null }, decision, gatewayExecutor)
    if (result.status === 'pending') return `Action queued for ${decision.tier}: ${a.actionType} → ${a.target}. Audit ID: ${result.auditId}. Operator approval required.`
    if (result.status === 'succeeded') return `Action executed: ${a.actionType} → ${a.target}. Audit ID: ${result.auditId}.${result.result ? ` Result: ${result.result}` : ''}`
    return `Action failed: ${a.actionType} → ${a.target}. ${result.result ?? ''}`
  },
}

export const investigationSearchTool: ToolDefinition = {
  name: 'investigation_search',
  description: 'Search investigations by status, severity, or name.',
  inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'active', 'suspended', 'resolved', 'closed'] }, search: { type: 'string' }, severity: { type: 'number' } } },
  tier: 'read', parallelSafe: true, availableIn: 'chat', category: 'security',
  handler: async (args) => {
    const a = _soc<{ status?: string; search?: string; severity?: number }>(args)
    const where: Record<string, unknown> = {}
    if (a.status) where.status = a.status
    if (a.search) where.OR = [{ name: { contains: a.search, mode: 'insensitive' } }]
    if (a.severity) where.severity = { gte: Number(a.severity) }
    const invs = await _socPrisma.investigation.findMany({ where, orderBy: { createdAt: 'desc' }, take: 25, select: { id: true, name: true, status: true, severity: true, tlp: true, _count: { select: { incidents: true, notes: true, observables: true } } } })
    const total = await _socPrisma.investigation.count({ where })
    return `Found ${total} (showing ${invs.length}):\n` + invs.map(i => `- [${i.status}] ${i.name} (sev:${i.severity} inc:${i._count.incidents} obs:${i._count.observables}) id:${i.id}`).join('\n')
  },
}

export const investigationCreateTool: ToolDefinition = {
  name: 'investigation_create',
  description: 'Create a new investigation case. Optionally link an incident.',
  inputSchema: { type: 'object', properties: { name: { type: 'string' }, severity: { type: 'number' }, tlp: { type: 'string', enum: ['white', 'green', 'amber', 'red'] }, tags: { type: 'array', items: { type: 'string' } }, incidentId: { type: 'string' } }, required: ['name'] },
  tier: 'write', parallelSafe: false, availableIn: 'chat', category: 'security',
  handler: async (args) => {
    const a = _soc<{ name: string; severity?: number; tlp?: string; tags?: string[]; incidentId?: string }>(args)
    const name = String(a.name ?? '').trim()
    if (!name) return 'Error: name required'
    const inv = await _socPrisma.investigation.create({ data: { name, severity: a.severity ?? 50, tlp: (a.tlp as any) ?? 'amber', tags: a.tags ?? [], mitreAttackIds: [], createdBy: 'warden' } })
    if (a.incidentId) { await _socPrisma.incident.updateMany({ where: { id: a.incidentId, investigationId: null }, data: { investigationId: inv.id } }); return `Investigation created: "${inv.name}" (id: ${inv.id}). Incident linked.` }
    return `Investigation created: "${inv.name}" (id: ${inv.id}, severity: ${inv.severity})`
  },
}

export const investigationReadTool: ToolDefinition = {
  name: 'investigation_read',
  description: 'Read full details of an investigation.',
  inputSchema: { type: 'object', properties: { investigationId: { type: 'string' } }, required: ['investigationId'] },
  tier: 'read', parallelSafe: true, availableIn: 'chat', category: 'security',
  handler: async (args) => {
    const a = _soc<{ investigationId: string }>(args)
    const inv = await _socPrisma.investigation.findUnique({ where: { id: a.investigationId }, include: { incidents: { take: 20 }, notes: { take: 20 }, observables: { take: 50 }, timeline: { orderBy: { eventTime: 'asc' }, take: 50 } } })
    if (!inv) return `Investigation ${a.investigationId} not found`
    return `"${inv.name}" | ${inv.status} | sev:${inv.severity} | ${inv.incidents.length} incidents, ${inv.observables.length} observables\n` +
      (inv.observables.length ? '\nObservables:\n' + inv.observables.map(o => `  [${o.category}] ${o.value} (${o.verdict})`).join('\n') : '') +
      (inv.incidents.length ? '\nIncidents:\n' + inv.incidents.map(i => `  [${i.status}] ${i.attackerKey ?? 'unknown'} sev:${i.severity}`).join('\n') : '')
  },
}

export const investigationNoteTool: ToolDefinition = {
  name: 'investigation_note',
  description: 'Add a note to an investigation.',
  inputSchema: { type: 'object', properties: { investigationId: { type: 'string' }, content: { type: 'string' } }, required: ['investigationId', 'content'] },
  tier: 'write', parallelSafe: false, availableIn: 'chat', category: 'security',
  handler: async (args) => {
    const a = _soc<{ investigationId: string; content: string }>(args)
    if (!a.investigationId || !a.content) return 'Error: investigationId and content required'
    const inv = await _socPrisma.investigation.findUnique({ where: { id: a.investigationId } })
    if (!inv) return `Investigation ${a.investigationId} not found`
    const note = await _socPrisma.investigationNote.create({ data: { investigationId: a.investigationId, content: a.content, author: 'warden', authorType: 'warden' } })
    await _socPrisma.investigationTimeline.create({ data: { investigationId: a.investigationId, eventTime: new Date(), eventType: 'note_added', title: 'Warden note added', source: 'warden' } })
    return `Note added (id: ${note.id})`
  },
}

export const investigationUpdateTool: ToolDefinition = {
  name: 'investigation_update',
  description: 'Update investigation status, severity, or TLP. Cannot set resolved/closed.',
  inputSchema: { type: 'object', properties: { investigationId: { type: 'string' }, status: { type: 'string', enum: ['open', 'active', 'suspended'] }, severity: { type: 'number' }, tlp: { type: 'string', enum: ['white', 'green', 'amber', 'red'] } }, required: ['investigationId'] },
  tier: 'write', parallelSafe: false, availableIn: 'chat', category: 'security',
  handler: async (args) => {
    const a = _soc<{ investigationId: string; status?: string; severity?: number; tlp?: string }>(args)
    if (!a.investigationId) return 'Error: investigationId required'
    const data: Record<string, unknown> = {}
    if (a.status) { if (a.status === 'resolved' || a.status === 'closed') return 'Error: Warden cannot set resolved/closed'; data.status = a.status }
    if (a.severity != null) data.severity = Number(a.severity)
    if (a.tlp) data.tlp = a.tlp
    await _socPrisma.investigation.update({ where: { id: a.investigationId }, data })
    return `Investigation updated: ${Object.keys(data).join(', ')}`
  },
}

export const investigationLinkIncidentTool: ToolDefinition = {
  name: 'investigation_link_incident',
  description: 'Link an incident to an investigation.',
  inputSchema: { type: 'object', properties: { investigationId: { type: 'string' }, incidentId: { type: 'string' } }, required: ['investigationId', 'incidentId'] },
  tier: 'write', parallelSafe: false, availableIn: 'chat', category: 'security',
  handler: async (args) => {
    const a = _soc<{ investigationId: string; incidentId: string }>(args)
    if (!a.investigationId || !a.incidentId) return 'Error: investigationId and incidentId required'
    const inc = await _socPrisma.incident.findUnique({ where: { id: a.incidentId } })
    if (!inc) return `Incident ${a.incidentId} not found`
    if (inc.investigationId && inc.investigationId !== a.investigationId) return `Incident already linked to ${inc.investigationId}`
    await _socPrisma.incident.update({ where: { id: a.incidentId }, data: { investigationId: a.investigationId } })
    await _socPrisma.investigationTimeline.create({ data: { investigationId: a.investigationId, eventTime: new Date(), eventType: 'link_added', title: `Incident linked: ${inc.attackerKey ?? a.incidentId}`, source: 'warden' } })
    return `Incident ${a.incidentId} linked to investigation ${a.investigationId}`
  },
}

export const observableAddTool: ToolDefinition = {
  name: 'observable_add',
  description: 'Add an observable (IP, domain, hash, URL) to an investigation.',
  inputSchema: { type: 'object', properties: { investigationId: { type: 'string' }, value: { type: 'string' }, category: { type: 'string', enum: ['ipv4', 'ipv6', 'domain', 'url', 'file_hash_md5', 'file_hash_sha1', 'file_hash_sha256', 'mac_address', 'email', 'username', 'file_path', 'registry_key', 'mutex', 'asn'] }, role: { type: 'string', enum: ['ioc', 'artifact', 'infrastructure'] }, verdict: { type: 'string', enum: ['malicious', 'suspicious', 'benign', 'unknown'] }, confidence: { type: 'number' }, context: { type: 'string' } }, required: ['investigationId', 'value', 'category'] },
  tier: 'write', parallelSafe: false, availableIn: 'chat', category: 'security',
  handler: async (args) => {
    const a = _soc<{ investigationId: string; value: string; category: string; role?: string; verdict?: string; confidence?: number; context?: string }>(args)
    if (!a.investigationId || !a.value || !a.category) return 'Error: investigationId, value, category required'
    const verdict = a.verdict ?? 'unknown'
    const confidence = a.confidence ?? 0
    if (verdict === 'malicious' && confidence < 80) return 'Error: confidence >= 80 required for malicious verdict'
    const obs = await _socPrisma.investigationObservable.upsert({
      where: { investigationId_value_category: { investigationId: a.investigationId, value: a.value, category: a.category as any } },
      create: { investigationId: a.investigationId, value: a.value, displayValue: a.value, category: a.category as any, role: (a.role as any) ?? 'ioc', verdict: verdict as any, confidence, context: a.context ?? 'Added by Warden', ...(verdict !== 'unknown' ? { verdictBy: 'warden', verdictAt: new Date() } : {}) },
      update: { lastSeen: new Date(), confidence, ...(verdict !== 'unknown' ? { verdict: verdict as any, verdictBy: 'warden', verdictAt: new Date() } : {}), ...(a.context ? { context: a.context } : {}) },
    })
    return `Observable added: [${a.category}] ${a.value} (verdict: ${verdict}, id: ${obs.id})`
  },
}

export const observableSetVerdictTool: ToolDefinition = {
  name: 'observable_set_verdict',
  description: 'Set verdict on an observable. Requires confidence >= 80 for malicious.',
  inputSchema: { type: 'object', properties: { observableId: { type: 'string' }, verdict: { type: 'string', enum: ['malicious', 'suspicious', 'benign', 'unknown'] }, confidence: { type: 'number' }, context: { type: 'string' } }, required: ['observableId', 'verdict'] },
  tier: 'write', parallelSafe: false, availableIn: 'chat', category: 'security',
  handler: async (args) => {
    const a = _soc<{ observableId: string; verdict: string; confidence?: number; context?: string }>(args)
    if (!a.observableId || !a.verdict) return 'Error: observableId and verdict required'
    const confidence = a.confidence ?? 0
    if (a.verdict === 'malicious' && confidence < 80) return 'Error: confidence >= 80 required for malicious verdict'
    const updated = await _socPrisma.investigationObservable.update({ where: { id: a.observableId }, data: { verdict: a.verdict as any, confidence, ...(a.context ? { context: a.context } : {}), ...(a.verdict !== 'unknown' ? { verdictBy: 'warden', verdictAt: new Date() } : {}) } })
    return `Verdict set: [${updated.category}] ${updated.value} → ${a.verdict} (confidence: ${confidence}%)`
  },
}

export const timelineAddTool: ToolDefinition = {
  name: 'timeline_add',
  description: 'Add a timeline entry to an investigation.',
  inputSchema: { type: 'object', properties: { investigationId: { type: 'string' }, eventTime: { type: 'string', description: 'ISO 8601' }, eventType: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' } }, required: ['investigationId', 'eventTime', 'eventType', 'title'] },
  tier: 'write', parallelSafe: false, availableIn: 'chat', category: 'security',
  handler: async (args) => {
    const a = _soc<{ investigationId: string; eventTime: string; eventType: string; title: string; description?: string }>(args)
    if (!a.investigationId) return 'Error: investigationId required'
    const entry = await _socPrisma.investigationTimeline.create({ data: { investigationId: a.investigationId, eventTime: new Date(a.eventTime), eventType: a.eventType, title: a.title, description: a.description, source: 'warden' } })
    return `Timeline entry added: "${a.title}" (id: ${entry.id})`
  },
}
