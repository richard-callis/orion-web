/**
 * Utility types and functions for the security SSE stream route.
 * Extracted so they can be unit-tested without triggering Next.js
 * route export validation (only HTTP verb handlers are valid exports).
 */

export type StreamChannel = 'incidents' | 'events' | 'approvals' | 'sources'

/**
 * Per R7 (SIEM_PLAN.md Risk Register), SSE frames carry ID-only payloads.
 */
export interface NotifyMessage {
  channel: StreamChannel
  payload: {
    id: string
    type: string
    timestamp: string
  }
}

/**
 * Build an ID-only SSE frame. Kept here so tests can lock in the R7 invariant
 * (frames must never embed row data — only the ID for the consumer to fetch).
 */
export function buildIdOnlyFrame(
  channel: StreamChannel,
  id: string,
  type: 'created' | 'updated' | 'deleted' = 'created',
  timestamp: string = new Date().toISOString()
): NotifyMessage {
  return {
    channel,
    payload: { id, type, timestamp },
  }
}
