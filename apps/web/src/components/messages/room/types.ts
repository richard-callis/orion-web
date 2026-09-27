export interface RoomMember {
  userId: string | null
  agentId: string | null
  role: string
  agent?: { id: string; name: string; type: string } | null
  user?: { id: string; username: string; name: string } | null
}

export interface ToolCallAttachment {
  tool: string
  input: string
  output?: string
}

export interface RoomMessage {
  id: string
  senderType: string
  content: string
  attachments: ToolCallAttachment | unknown[] | null
  sender: { type: string; id: string | null; name: string }
  createdAt: string
}

export interface RoomGoal { id: string; text: string; status: string; createdAt: string }

export interface RoomDetail {
  id: string
  name: string
  description: string | null
  type: string
  createdBy: string
  createdAt: string
  updatedAt: string
  taskId?: string | null
  featureId?: string | null
  epicId?: string | null
  _count?: { messages: number; members: number }
  totalMessages?: number
  members?: RoomMember[]
  messages?: RoomMessage[]
  activeGoal?: RoomGoal | null
}

export interface InviteOption {
  id: string
  name: string
  type: string
  username?: string
}

/**
 * Combine a freshly fetched page of messages with what is already on screen.
 * Messages that arrived over SSE while the request was in flight are kept,
 * and duplicates (same id) are dropped.
 */
export function mergeMessages(fetched: RoomMessage[], current: RoomMessage[]): RoomMessage[] {
  const seen = new Set(fetched.map(m => m.id))
  const lastFetchedAt = fetched.length ? fetched[fetched.length - 1].createdAt : ''
  const newer = current.filter(m => !seen.has(m.id) && m.createdAt >= lastFetchedAt)
  return newer.length ? [...fetched, ...newer] : fetched
}

/** API path of the epic/feature/task a planning room is attached to, if any. */
export function planTargetUrl(room: Pick<RoomDetail, 'epicId' | 'featureId' | 'taskId'>): string | null {
  return room.epicId    ? `/api/epics/${room.epicId}`
       : room.featureId ? `/api/features/${room.featureId}`
       : room.taskId    ? `/api/tasks/${room.taskId}`
       : null
}
