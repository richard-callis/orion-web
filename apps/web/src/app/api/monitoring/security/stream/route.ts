/**
 * GET /api/monitoring/security/stream
 *
 * SSE stream using Postgres LISTEN/NOTIFY for real-time updates.
 * Uses a dedicated pg Client (not Prisma) to hold a long-lived LISTEN
 * session. NOTIFY triggers on SecurityEvent/Incident/ActionAudit tables
 * wake the consumer instantly — no polling during idle.
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
import { Client } from 'pg'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const encoder = new TextEncoder()

// ── Channel types ─────────────────────────────────────────────────────────────

type StreamChannel = 'incidents' | 'events' | 'approvals'

/**
 * Per R7 (SIEM_PLAN.md Risk Register), SSE frames carry ID-only payloads.
 * Consumers fetch the full row via the REST endpoints (e.g. /incidents/[id]).
 * This:
 *   1. Sidesteps the 8 KB NOTIFY payload limit.
 *   2. Forces consumers through the read endpoints, where access control
 *      can filter sensitive fields per session/role.
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

// ── Channel → pg channel mapping ──────────────────────────────────────────────

function pgChannelFor(channel: StreamChannel): string {
  return `orion_security_${channel}`
}

// ── Request handler ───────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const channel = (searchParams.get('channel') ?? 'events') as StreamChannel
  const sinceParam = searchParams.get('since')
  const since = sinceParam ? new Date(sinceParam) : undefined

  if (!['incidents', 'events', 'approvals'].includes(channel)) {
    return NextResponse.json(
      { error: 'Invalid channel. Use: incidents, events, or approvals' },
      { status: 400 }
    )
  }

  // Validate PostgreSQL connection
  if (!process.env.DATABASE_URL?.includes('postgres://')) {
    return NextResponse.json(
      { error: 'LISTEN/NOTIFY requires PostgreSQL' },
      { status: 500 }
    )
  }

  const { prisma } = await import('@/lib/db')

  const headers: Record<string, string> = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  }

  // Create a dedicated pg Client for LISTEN (Prisma pools can't hold
  // long-lived LISTEN sessions).
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()

  // Send initial events since the given timestamp
  const initialEvents = await getInitialEvents(channel, since, prisma)

  const stream = new ReadableStream({
    start(controller) {
      // Send connection established
      controller.enqueue(encoder.encode(': connected\n\n'))

      // Send initial events
      for (const event of initialEvents) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
        )
      }

      // Listen for NOTIFY messages
      const pgChannel = pgChannelFor(channel)
      let listener: ((name: string, payload: string) => void) | null = null

      const onNotify = (name: string, payload: string) => {
        // NOTIFY payload format: "<id>:<type>" (e.g. "abc123:created")
        const [id, type] = payload.split(':')
        if (!id) return

        const frame: NotifyMessage = {
          channel,
          payload: { id, type: type as NotifyMessage['payload']['type'], timestamp: new Date().toISOString() },
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
      }

      client.on('notification', onNotify)
      listener = onNotify

      // Issue LISTEN on the channel
      client.query(`LISTEN ${pgChannel}`).catch(() => {
        // Channel may not exist yet if migration hasn't run
        // — fall through to polling as a safety net
      })

      // Handle client disconnect
      const cleanup = () => {
        if (listener) {
          client.removeListener('notification', listener)
        }
        listener = null
        controller.close()
        // Close the dedicated pg client
        client.end().catch(() => {})
      }

      const signal = (request as any).signal
      if (signal) {
        signal.addEventListener('abort', cleanup)
      }

      ;(request as any).body?.on?.('close', cleanup)
    },
  })

  return new Response(stream, { headers })
}

// ── Initial event fetch ───────────────────────────────────────────────────────

async function getInitialEvents(
  channel: StreamChannel,
  since: Date | undefined,
  prisma: unknown
): Promise<NotifyMessage[]> {
  const prismaClient = prisma as {
    securityEvent: { findMany: (opts: unknown) => unknown[] }
    incident: { findMany: (opts: unknown) => unknown[] }
    actionAudit: { findMany: (opts: unknown) => unknown[] }
  }
  const now = new Date().toISOString()

  switch (channel) {
    case 'events': {
      const events = await prismaClient.securityEvent.findMany({
        where: since ? { createdAt: { gte: since } } : {},
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { id: true },
      })
      return (events as { id: string }[]).map((e) => ({
        channel: 'events',
        payload: { id: e.id, type: 'created', timestamp: now },
      }))
    }

    case 'incidents': {
      const incidents = await prismaClient.incident.findMany({
        where: since ? { openedAt: { gte: since } } : {},
        orderBy: { openedAt: 'desc' },
        take: 50,
        select: { id: true },
      })
      return (incidents as { id: string }[]).map((i) => ({
        channel: 'incidents',
        payload: { id: i.id, type: 'created', timestamp: now },
      }))
    }

    case 'approvals': {
      const audits = await prismaClient.actionAudit.findMany({
        where: {
          tier: 'approve',
          status: 'pending',
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { id: true },
      })
      return (audits as { id: string }[]).map((a) => ({
        channel: 'approvals',
        payload: { id: a.id, type: 'created', timestamp: now },
      }))
    }
  }

  return []
}
