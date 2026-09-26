'use client'
import useSWR from 'swr'

export interface PendingValidationTask {
  id: string
  title: string
  status: string
  metadata: Record<string, unknown> | null
}

export const PENDING_VALIDATION_KEY = '/api/tasks?status=pending_validation'

/**
 * Tasks in `pending_validation`. Shared by the plan-approval and
 * budget-paused notifications, so both render from a single request.
 */
export function usePendingValidationTasks(intervalMs = 15_000) {
  const { data, mutate } = useSWR<PendingValidationTask[]>(PENDING_VALIDATION_KEY, {
    refreshInterval: intervalMs,
  })
  return { tasks: Array.isArray(data) ? data : [], mutate }
}
