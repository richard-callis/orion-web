'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import { Loader2, BookmarkCheck } from 'lucide-react'
import { apiFetch, errorMessage } from '@/lib/api'
import { useToast } from '@/components/ui/Toast'
import { ChatMessageItem } from './room/ChatMessageItem'
import { useRoomStream } from './room/useRoomStream'
import { RoomHeader, InlineInputRow, MembersBar, GoalBanner, TypingIndicator } from './room/RoomPanels'
import { RoomComposer } from './room/RoomComposer'
import { InviteMemberDialog, LeaveRoomDialog } from './room/RoomDialogs'
import { planTargetUrl, type RoomMember } from './room/types'

interface Props {
  roomId: string
  onMobileBack: () => void
  onLeave?: () => void
}

export function RoomChat({ roomId, onMobileBack, onLeave }: Props) {
  const toast = useToast()
  const { room, loading, tokenState, typing, reload, loadMore } = useRoomStream(roomId)

  const [sending, setSending] = useState(false)
  const [showInvite, setShowInvite] = useState(false)
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false)
  const [showSetGoal, setShowSetGoal] = useState(false)
  const [settingGoal, setSettingGoal] = useState(false)
  const [completingGoal, setCompletingGoal] = useState(false)
  const [compacting, setCompacting] = useState(false)
  const [savedPlanMsgId, setSavedPlanMsgId] = useState<string | null>(null)
  const [planToast, setPlanToast] = useState<{ msgId: string; prevPlan: string | null } | null>(null)
  const [hoveredMsgId, setHoveredMsgId] = useState<string | null>(null)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const nearBottomRef = useRef(true)
  const planTimersRef = useRef<ReturnType<typeof setTimeout>[]>([])

  useEffect(() => { nearBottomRef.current = true }, [roomId])

  useEffect(() => {
    const timers = planTimersRef.current
    return () => { timers.forEach(clearTimeout) }
  }, [])

  // Debounce scroll to avoid performance issues with rapid message arrivals
  useEffect(() => {
    const timer = setTimeout(() => {
      if (nearBottomRef.current) messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }, 100)
    return () => clearTimeout(timer)
  }, [room?.messages?.length])

  /** Run a room action, then reload; failures are toasted. */
  const act = useCallback(async (what: string, fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      await fn()
      await reload()
      return true
    } catch (e) {
      toast.error(`Failed to ${what}: ${errorMessage(e)}`)
      return false
    }
  }, [reload, toast])

  // ── Plans ──────────────────────────────────────────────────────────────────

  const saveAsPlan = useCallback(async (msgId: string, content: string) => {
    const url = room ? planTargetUrl(room) : null
    if (!url) return
    // Store previous plan for undo
    let prevPlan: string | null = null
    try {
      prevPlan = (await apiFetch<{ plan?: string | null }>(url)).plan ?? null
    } catch { /* no previous plan to restore */ }
    try {
      await apiFetch(url, { method: 'PATCH', body: { plan: content } })
    } catch (e) {
      toast.error(`Failed to save plan: ${errorMessage(e)}`)
      return
    }
    setSavedPlanMsgId(msgId)
    setPlanToast({ msgId, prevPlan })
    planTimersRef.current.push(
      setTimeout(() => setSavedPlanMsgId(null), 3000),
      setTimeout(() => setPlanToast(null), 5000),
    )
  }, [room, toast])

  const undoPlan = useCallback(async () => {
    const url = room ? planTargetUrl(room) : null
    if (!url || !planToast) return
    try {
      await apiFetch(url, { method: 'PATCH', body: { plan: planToast.prevPlan } })
    } catch (e) {
      toast.error(`Failed to undo: ${errorMessage(e)}`)
      return
    }
    setPlanToast(null)
    setSavedPlanMsgId(null)
  }, [room, planToast, toast])

  // ── Messages / members / goals ─────────────────────────────────────────────

  const sendMessage = async (content: string): Promise<boolean> => {
    if (!room || sending) return false
    setSending(true)
    nearBottomRef.current = true
    try {
      // Messages arrive via SSE; the reload only refreshes metadata/counts.
      return await act('send message', () => apiFetch(`/api/chatrooms/${room.id}/messages`, { method: 'POST', body: { content } }))
    } finally {
      setSending(false)
    }
  }

  const leave = async () => {
    try {
      await apiFetch(`/api/chatrooms/${roomId}/join`, { method: 'DELETE' })
    } catch { /* leave the view regardless */ }
    setShowLeaveConfirm(false)
    if (onLeave) onLeave()
    else onMobileBack()
  }

  const kick = (member: RoomMember) => {
    const param = member.agentId ? `agentId=${member.agentId}` : `userId=${member.userId}`
    void act('remove member', () => apiFetch(`/api/chatrooms/${roomId}/members?${param}`, { method: 'DELETE' }))
  }

  const setGoal = async (text: string) => {
    setSettingGoal(true)
    const ok = await act('set goal', () => apiFetch(`/api/chatrooms/${roomId}/goals`, { method: 'POST', body: { text } }))
    setSettingGoal(false)
    if (ok) setShowSetGoal(false)
  }

  const completeGoal = async (summary: string) => {
    if (!room?.activeGoal || completingGoal) return
    setCompletingGoal(true)
    await act('complete goal', () => apiFetch(`/api/chatrooms/${roomId}/goals/${room.activeGoal!.id}`, {
      method: 'PATCH', body: { status: 'completed', completionSummary: summary || undefined },
    }))
    setCompletingGoal(false)
  }

  const abandonGoal = () => {
    if (!room?.activeGoal) return
    void act('abandon goal', () => apiFetch(`/api/chatrooms/${roomId}/goals/${room.activeGoal!.id}`, {
      method: 'PATCH', body: { status: 'abandoned' },
    }))
  }

  const compact = async () => {
    setCompacting(true)
    await act('compact context', () => apiFetch(`/api/chatrooms/${roomId}/compact`, { method: 'POST' }))
    setCompacting(false)
  }

  const isPlanningRoom = Boolean(room?.type === 'planning' && (room.epicId || room.featureId || room.taskId))
  const messages = room?.messages ?? []

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
      <RoomHeader
        room={room}
        tokenState={tokenState}
        compacting={compacting}
        onCompact={() => void compact()}
        onMobileBack={onMobileBack}
        onInvite={() => setShowInvite(true)}
        onToggleGoal={() => setShowSetGoal(v => !v)}
        onLeave={() => setShowLeaveConfirm(true)}
      />

      {showSetGoal && (
        <InlineInputRow
          label="Room goal"
          placeholder="Describe the goal for this room…"
          submitLabel="Set"
          busyLabel="Setting…"
          busy={settingGoal}
          requireText
          tone="accent"
          className="border-b border-border-subtle shrink-0 bg-bg-raised"
          onSubmit={text => void setGoal(text)}
          onCancel={() => setShowSetGoal(false)}
        />
      )}

      <MembersBar members={room?.members ?? []} onKick={kick} />

      {room?.activeGoal && (
        <GoalBanner
          goal={room.activeGoal}
          completing={completingGoal}
          onComplete={summary => void completeGoal(summary)}
          onAbandon={abandonGoal}
        />
      )}

      {/* Messages */}
      <div
        className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3"
        role="log"
        aria-live="polite"
        aria-label="Messages"
        onScroll={e => {
          const el = e.currentTarget
          nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 150
        }}
      >
        {loading ? (
          <div className="flex items-center justify-center h-full"><Loader2 size={20} className="animate-spin text-text-muted" /></div>
        ) : (
          <>
            {room?.totalMessages && room.totalMessages > messages.length ? (
              <div className="text-center py-2">
                <button onClick={loadMore} className="text-xs text-accent hover:text-accent/80 transition-colors">
                  ↑ Load more ({room.totalMessages - messages.length} older messages)
                </button>
              </div>
            ) : null}
            {messages.length === 0 && (
              <div className="text-center text-text-muted text-xs py-8">No messages yet. Start the conversation!</div>
            )}
            {messages.map(msg => (
              <ChatMessageItem
                key={msg.id}
                msg={msg}
                isPlanningRoom={isPlanningRoom}
                isHovered={hoveredMsgId === msg.id}
                isSaved={savedPlanMsgId === msg.id}
                onHover={setHoveredMsgId}
                onSaveAsPlan={saveAsPlan}
              />
            ))}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      <TypingIndicator names={typing} />

      <RoomComposer members={room?.members ?? []} sending={sending} onSend={sendMessage} />

      {showInvite && (
        <InviteMemberDialog
          roomId={roomId}
          onClose={() => setShowInvite(false)}
          onInvited={() => { setShowInvite(false); void reload() }}
        />
      )}

      {/* Plan saved toast (has an Undo action, so it stays local) */}
      {planToast && (
        <div role="status" className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-2.5 rounded-lg bg-bg-sidebar border border-border-visible shadow-xl text-xs text-text-primary">
          <BookmarkCheck size={14} className="text-status-healthy shrink-0" />
          <span>Plan saved</span>
          <button onClick={() => void undoPlan()} className="text-accent hover:text-accent/80 font-medium transition-colors">
            Undo
          </button>
        </div>
      )}

      {showLeaveConfirm && (
        <LeaveRoomDialog onCancel={() => setShowLeaveConfirm(false)} onConfirm={() => void leave()} />
      )}
    </div>
  )
}
