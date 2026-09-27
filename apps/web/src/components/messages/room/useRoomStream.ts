'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import useSWR from 'swr'
import { apiFetch } from '@/lib/api'
import { useSSE } from '@/hooks/useSSE'
import { mergeMessages, type RoomDetail, type RoomMessage } from './types'

type RoomResponse = RoomDetail & { tokenCount?: number; tokenLimit?: number | null }

type StreamEvent =
  | { type: 'connected' }
  | { type: 'token-update'; tokenCount: number; tokenLimit: number | null }
  | (RoomMessage & { type?: undefined })

const PAGE = 100

const isGoalNotice = (m: RoomMessage) =>
  m.senderType === 'system' &&
  typeof m.content === 'string' &&
  (m.content.startsWith('🎯') || m.content.startsWith('✓ Goal') || m.content.startsWith('✗ Goal'))

/**
 * Live state for one chat room: detail + messages (paged), token usage and
 * who is typing.
 *
 * - Messages stream in over SSE; on every *re*connect the room is reloaded so
 *   messages sent while disconnected appear. Duplicates are dropped by id.
 * - Responses for a room the user already left are discarded.
 * - Typing state is polled every 2s through SWR (paused while the tab is hidden).
 */
export function useRoomStream(roomId: string) {
  const [room, setRoom] = useState<RoomDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [messageLimit, setMessageLimit] = useState(PAGE)
  const [tokenState, setTokenState] = useState<{ count: number; limit: number | null }>({ count: 0, limit: null })

  // Latest roomId / limit, used by async callbacks.
  const roomIdRef = useRef(roomId)
  roomIdRef.current = roomId
  const messageLimitRef = useRef(messageLimit)
  messageLimitRef.current = messageLimit
  const hasConnectedRef = useRef(false)

  const reload = useCallback(async (limit?: number) => {
    const requestedRoom = roomId
    try {
      const detail = await apiFetch<RoomResponse>(`/api/chatrooms/${requestedRoom}?messages=${limit ?? messageLimitRef.current}`)
      if (roomIdRef.current !== requestedRoom) return
      setRoom(prev => (
        prev && prev.id === detail.id
          ? { ...detail, messages: mergeMessages(detail.messages ?? [], prev.messages ?? []) }
          : detail
      ))
      setTokenState({ count: detail.tokenCount ?? 0, limit: detail.tokenLimit ?? null })
    } catch { /* keep what is on screen */ }
    if (roomIdRef.current === requestedRoom) setLoading(false)
  }, [roomId])

  // Switching rooms: clear the previous room so its data never shows under the new id.
  useEffect(() => {
    setRoom(null)
    setLoading(true)
    setMessageLimit(PAGE)
    hasConnectedRef.current = false
    void reload(PAGE)
  }, [reload])

  const loadMore = useCallback(() => {
    const next = messageLimitRef.current + PAGE
    setMessageLimit(next)
    void reload(next)
  }, [reload])

  useSSE(roomId ? `/api/chatrooms/${roomId}/stream` : null, {
    onEvent: raw => {
      const evt = raw as StreamEvent
      if (!evt || typeof evt !== 'object') return
      if (evt.type === 'connected') {
        if (hasConnectedRef.current) void reload()
        hasConnectedRef.current = true
        return
      }
      if (evt.type === 'token-update') {
        setTokenState({ count: evt.tokenCount, limit: evt.tokenLimit })
        return
      }
      const message = evt as RoomMessage
      setRoom(prev => {
        if (!prev || prev.id !== roomIdRef.current) return prev
        if (message.id && prev.messages?.some(m => m.id === message.id)) return prev
        const next = [...(prev.messages ?? []), message]
        // Keep the DOM bounded, but never below what the user explicitly loaded
        const cap = Math.max(200, messageLimitRef.current)
        return {
          ...prev,
          messages: next.length > cap ? next.slice(-cap) : next,
          totalMessages: (prev.totalMessages || 0) + 1,
        }
      })
      // Reload room data when a goal notice arrives so the banner updates
      if (isGoalNotice(message)) void reload()
    },
  })

  const { data: typingData } = useSWR<{ typing: string[] }>(
    roomId ? `/api/chatrooms/${roomId}/typing` : null,
    { refreshInterval: 2000, revalidateOnFocus: false, shouldRetryOnError: false },
  )
  const typing = typingData?.typing ?? []

  return { room, loading, tokenState, typing, reload, loadMore }
}
