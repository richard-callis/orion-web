'use client'
import { useCallback } from 'react'
import { useRouter } from 'next/navigation'
import type { PlanTarget } from '@/types/tasks'
import { apiFetch, errorMessage } from '@/lib/api'
import { useToast } from '../ui/Toast'

const ROOM_PREFIX: Record<PlanTarget['type'], string> = {
  epic:    '◆ EPIC · ',
  feature: '▸ FEAT · ',
  task:    '● TASK · ',
}

/**
 * Returns `planWithAI(target)`: creates a planning chat room for the target and
 * navigates to it. The room's opening context (target + parent lineage) is
 * seeded server-side by POST /api/chatrooms for type "planning".
 */
export function usePlanWithAI() {
  const router = useRouter()
  const toast = useToast()
  return useCallback(async (target: PlanTarget) => {
    try {
      // Use the unified ChatRoom model for planning conversations
      const room = await apiFetch<{ id: string }>('/api/chatrooms', {
        method: 'POST',
        body: {
          name:       `${ROOM_PREFIX[target.type]}${target.title}`,
          type:       'planning',
          // Structural links for epic/feature-type planning
          epicId:     target.type === 'epic'    ? target.id : undefined,
          featureId:  target.type === 'feature' ? target.id : undefined,
          // planTarget stored for caller routing / display
          planTarget: { type: target.type, id: target.id },
        },
      })
      router.push(`/messages?r=${room.id}`)
    } catch (e) {
      toast.error(`Failed to start planning chat: ${errorMessage(e)}`)
    }
  }, [router, toast])
}
