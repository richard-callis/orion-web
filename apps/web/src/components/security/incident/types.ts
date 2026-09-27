export interface ActionAudit {
  id: string
  actionType: string
  target: string
  tier: string
  status: string
  proposedBy: string
  approvedBy: string | null
  result: string | null
  payload: unknown
  createdAt: string
}

export interface ChatMessage {
  id: string
  content: string
  createdAt: string
  senderType: string
}

export interface Observable {
  id: string
  value: string
  displayValue: string | null
  category: string
  role: string
  verdict: string
  confidence: number
  firstSeen: string
}

export interface Note {
  id: string
  content: string
  author: string
  authorType: string
  createdAt: string
}

export interface TimelineEntry {
  id: string
  eventTime: string
  eventType: string
  title: string
  description: string | null
  source: string | null
}

export interface Investigation {
  id: string
  observables: Observable[]
  notes: Note[]
  timeline: TimelineEntry[]
}

export interface Incident {
  id: string
  status: string
  severity: number
  rootCauseSummary: string | null
  attackerKey: string | null
  hostKey: string | null
  openedAt: string
  closedAt: string | null
  investigationId: string | null
}

export interface IncidentEvent {
  id: string
  type: string
  source: string
  severity: number
  title: string
  createdAt: string
  acknowledged: boolean
}

export interface IncidentData {
  incident: Incident
  events: IncidentEvent[]
  actions: ActionAudit[]
  chatMessages: ChatMessage[]
}

export const STATUS_FLOW = ['open', 'triaged', 'contained', 'closed'] as const

export const OBSERVABLE_CATEGORIES = [
  'ipv4', 'ipv6', 'domain', 'url', 'file_hash_md5', 'file_hash_sha1', 'file_hash_sha256',
  'mac_address', 'email', 'username', 'file_path', 'registry_key', 'mutex', 'asn',
] as const

export type IncidentTab = 'events' | 'actions' | 'chat' | 'observables' | 'notes' | 'timeline'
