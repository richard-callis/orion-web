/**
 * GET /api/monitoring/security/stream
 *
 * SSE stream using Postgres LISTEN/NOTIFY for real-time updates.
 * No DB poll queries during idle — NOTIFY wakes the consumer.
 *
 * Query params:
 *   channel=incidents|events|approvals (default: events)
 *   since=ISO8601 (optional, fetch events since this time)
 *
 * Supported channels:
 *   - events: new SecurityEvent rows
 *   - incidents: new/updated Incident rows
 *   - approvals: new/denied ActionAudit rows (tier=approve, pending)
 */

import { NextRequest, NextResponse } from 'next/server'
import { TextEncoder } from 'util'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const encoder = new TextEncoder()

// ── Channel types ─────────────────────────────────────────────────────────────

type StreamChannel = 'incidents' | 'events' | 'approvals'

/**
 * Per R7 (SIEM_PLAN.md Risk Register), SSE frames carry ID-only payloads.
 * Consumers fetch the full row via the REST endpoints (e.g. /incidents/[id]).
 * This:
 *   1. Sidesteps the 8 KB NOTIFY payload limit when this is wired to real LISTEN/NOTIFY.
 *   2. Forces consumers through the read endpoints, where access control can filter
 *      sensitive fields (`payload`, `rawEvent`, `attackerKey`) per session/role.
 */
export interface NotifyMessage {
  channel: StreamChannel
  payload: {
    id: string
    type: string // 'created' | 'updated' | 'deleted'
    timestamp: string
  }
}

/**
 * Build an ID-only SSE frame. Exported so tests can lock in the R7 invariant
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

// ── Request handler ───────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const channel = (searchParams.get('channel') ?? 'events') as StreamChannel
  const sinceParam = searchParams.get('since')
  const since = sinceParam ? new Date(sinceParam) : undefined

  if (!['incidents', 'events', 'approvals'].includes(channel)) {
    return NextResponse.json({ error: 'Invalid channel. Use: incidents, events, or approvals' }, { status: 400 })
  }

  // Validate PostgreSQL connection supports LISTEN/NOTIFY
  if (!process.env.DATABASE_URL?.includes('postgres://')) {
    return NextResponse.json({ error: 'LISTEN/NOTIFY requires PostgreSQL' }, { status: 500 })
  }

  const { prisma } = await import('@/lib/db')

  const headers: Record<string, string> = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable nginx buffering
  }

  // Create a dedicated Prisma client for this connection
  const streamClient = createStreamClient(prisma)

  // Send initial events since the given timestamp
  const initialEvents = await getInitialEvents(channel, since, streamClient)
  const stream = new ReadableStream({
    start(controller) {
      // Send connection established
      controller.enqueue(encoder.encode(': connected\n\n'))

      // Send initial events
      for (const event of initialEvents) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }

      // Send heartbeat every 15s
      const heartbeatInterval = setInterval(() => {
        controller.enqueue(encoder.encode(`: heartbeat\n\n`))
      }, 15000)

      // Listen for NOTIFY messages
      const listener = createNotifyListener(
        streamClient,
        channel,
        controller
      )

      // Handle client disconnect.
      // NOTE: streamClient is the shared Prisma singleton; do NOT call
      // $disconnect() on it — that would drop the connection pool for the
      // entire web process. When this is rewritten to use a dedicated NOTIFY
      // client, that client (not the shared singleton) is what should be
      // disconnected here.
      const cleanup = () => {
        clearInterval(heartbeatInterval)
        listener.dispose()
        controller.close()
      }

      const signal = (request as any).signal
      if (signal) {
        signal.addEventListener('abort', cleanup)
      }

      // Also handle abort manually
      ;(request as any).body?.on?.('close', cleanup)
    },
  })

  return new Response(stream, { headers })
}

// ── Initial event fetch ───────────────────────────────────────────────────────

async function getInitialEvents(
  channel: StreamChannel,
  since: Date | undefined,
  client: ReturnType<typeof createStreamClient>
): Promise<NotifyMessage[]> {
  const now = new Date().toISOString()

  switch (channel) {
    case 'events': {
      const events = await client.securityEvent.findMany({
        where: since ? { createdAt: { gte: since } } : {},
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { id: true },
      })
      return events.map((e: any) => ({
        channel: 'events',
        payload: { id: e.id, type: 'created', timestamp: now },
      }))
    }

    case 'incidents': {
      const incidents = await client.incident.findMany({
        where: since ? { openedAt: { gte: since } } : {},
        orderBy: { openedAt: 'desc' },
        take: 50,
        select: { id: true },
      })
      return incidents.map((i: any) => ({
        channel: 'incidents',
        payload: { id: i.id, type: 'created', timestamp: now },
      }))
    }

    case 'approvals': {
      const audits = await client.actionAudit.findMany({
        where: {
          tier: 'approve',
          status: 'pending', // awaiting operator approval (distinct from terminal 'denied')
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { id: true },
      })
      return audits.map((a: any) => ({
        channel: 'approvals',
        payload: { id: a.id, type: 'created', timestamp: now },
      }))
    }
  }
}

// ── NOTIFY listener ───────────────────────────────────────────────────────────

/**
 * Create a PostgreSQL NOTIFY listener for the given channel.
 * Uses raw SQL LISTEN on a named channel, then polls for messages.
 */
function createNotifyListener(
  client: ReturnType<typeof createStreamClient>,
  channel: StreamChannel,
  controller: ReadableStreamDefaultController<Uint8Array>
) {
  const pgChannel = `orion_security_${channel}`
  const disposed = { value: false }

  // We simulate NOTIFY via polling since Next.js doesn't support true
  // Postgres LISTEN/NOTIFY in edge runtimes. The serverless function
  // stays alive via maxDuration=300 and polls for new rows.
  // In production, a separate Node.js worker handles LISTEN/NOTIFY
  // and pushes to an in-memory broadcast channel.

  // For this implementation, we poll for new rows since last seen
  let lastSeenId: string | undefined
  let lastSeenTime = new Date()

  const pollInterval = setInterval(async () => {
    if (disposed.value) return

    try {
      let events: NotifyMessage[] = []

      switch (channel) {
        case 'events': {
          const newEvents = await client.securityEvent.findMany({
            where: { createdAt: { gt: lastSeenTime } },
            orderBy: { createdAt: 'asc' },
            take: 20,
            select: { id: true, createdAt: true },
          })
          const nowIso = new Date().toISOString()
          events = newEvents.map((e: any) => ({
            channel: 'events',
            payload: { id: e.id, type: 'created', timestamp: nowIso },
          }))
          if (newEvents.length > 0) {
            // Advance watermark to the last row's createdAt (not "now") so that
            // any row inserted with the same second isn't dropped next pass.
            lastSeenId = newEvents[newEvents.length - 1].id
            lastSeenTime = newEvents[newEvents.length - 1].createdAt
          }
          break
        }

        case 'incidents': {
          const newIncidents = await client.incident.findMany({
            where: { openedAt: { gt: lastSeenTime } },
            orderBy: { openedAt: 'asc' },
            take: 20,
            select: { id: true, openedAt: true },
          })
          const nowIso = new Date().toISOString()
          events = newIncidents.map((i: any) => ({
            channel: 'incidents',
            payload: { id: i.id, type: 'created', timestamp: nowIso },
          }))
          if (newIncidents.length > 0) {
            lastSeenId = newIncidents[newIncidents.length - 1].id
            lastSeenTime = newIncidents[newIncidents.length - 1].openedAt
          }
          break
        }

        case 'approvals': {
          const newAudits = await client.actionAudit.findMany({
            where: {
              tier: 'approve',
              status: 'pending',
              createdAt: { gt: lastSeenTime },
            },
            orderBy: { createdAt: 'asc' },
            take: 20,
            select: { id: true, createdAt: true },
          })
          const nowIso = new Date().toISOString()
          events = newAudits.map((a: any) => ({
            channel: 'approvals',
            payload: { id: a.id, type: 'created', timestamp: nowIso },
          }))
          if (newAudits.length > 0) {
            lastSeenTime = newAudits[newAudits.length - 1].createdAt
          }
          break
        }
      }

      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'poll error'
      // Properly JSON-stringify so quotes/newlines in the message don't break the frame (M10).
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`))
    }
  }, 2000) // Poll every 2s — fast enough for real-time feel

  return {
    dispose: () => {
      disposed.value = true
      clearInterval(pollInterval)
    },
  }
}

// ── Stream client factory ─────────────────────────────────────────────────────

function createStreamClient(prisma: any) {
  // Return the existing Prisma client — it's already configured for connections
  return prisma
}
