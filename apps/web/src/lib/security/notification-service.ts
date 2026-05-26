/**
 * Notification service for SOC events.
 *
 * Channels (configurable in SecurityConfig):
 *  - ntfy topic push (primary — homelab native)
 *  - Slack webhook (optional)
 *
 * Respects quiet hours if configured in SystemSetting.
 */

import { prisma } from '@/lib/db'

// ── Types ────────────────────────────────────────────────────────────────────────

export interface NotificationPayload {
  title: string
  body: string
  priority?: number // 1-5, ntfy priority
  tags?: string[]
  actions?: string[]
}

// ── Quiet hours ──────────────────────────────────────────────────────────────────

/**
 * Check if the current time falls within quiet hours.
 * Quiet hours are configured in SystemSetting key 'socQuietHours' as JSON:
 * { start: '23:00', end: '07:00', enabled: true }
 */
async function isQuietHours(): Promise<boolean> {
  try {
    const setting = await prisma.systemSetting.findUnique({
      where: { key: 'socQuietHours' },
    })
    if (!setting) return false

    const config = setting.value as { start: string; end: string; enabled: boolean }
    if (!config.enabled) return false

    const now = new Date()
    const currentMinutes = now.getHours() * 60 + now.getMinutes()

    const [startH, startM] = config.start.split(':').map(Number)
    const [endH, endM] = config.end.split(':').map(Number)
    const startMinutes = startH * 60 + startM
    const endMinutes = endH * 60 + endM

    if (startMinutes > endMinutes) {
      // Wraps midnight (e.g. 23:00 → 07:00)
      return currentMinutes >= startMinutes || currentMinutes <= endMinutes
    }
    return currentMinutes >= startMinutes && currentMinutes <= endMinutes
  } catch {
    return false
  }
}

// ── ntfy ─────────────────────────────────────────────────────────────────────────

async function sendNtfy(payload: NotificationPayload): Promise<boolean> {
  const url = process.env.NTFY_URL
  const topic = process.env.NTFY_TOPIC ?? 'orion-soc'

  if (!url) return false

  try {
    const res = await fetch(`${url}/${topic}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        Title: payload.title,
        Priority: String(payload.priority ?? 3),
        ...(payload.tags ? { Tags: payload.tags.join(',') } : {}),
        ...(payload.actions ? { 'Actions': payload.actions.join(',') } : {}),
      },
      body: payload.body,
    })
    return res.ok
  } catch {
    return false
  }
}

// ── Slack ──────────────────────────────────────────────────────────────────────

async function sendSlack(payload: NotificationPayload): Promise<boolean> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL
  if (!webhookUrl) return false

  try {
    const emojiMap: Record<number, string> = {
      1: ':red_circle:', 2: ':orange_circle:', 3: ':yellow_circle:',
      4: ':blue_circle:', 5: ':large_blue_circle:',
    }

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `${emojiMap[payload.priority ?? 3] || ':large_blue_circle:'} ${payload.title}`,
        attachments: [{ color: '#36a64f', text: payload.body }],
      }),
    })
    return res.ok
  } catch {
    return false
  }
}

// ── Send notification ──────────────────────────────────────────────────────────

/**
 * Send a notification via all configured channels.
 * Respects quiet hours (silent unless priority >= 4).
 * Fire-and-forget — does not block the caller.
 */
export async function sendNotification(
  payload: NotificationPayload,
  options: { urgent?: boolean } = {},
): Promise<void> {
  const quiet = await isQuietHours()
  if (quiet && !options.urgent && (payload.priority ?? 3) < 4) return

  await Promise.allSettled([
    sendNtfy(payload),
    sendSlack(payload),
  ])
}

// ── Trigger events (§1.8) ──────────────────────────────────────────────────────

/**
 * New incident auto-linked to open investigation (Warden)
 */
export async function notifyIncidentLinked(
  incidentId: string,
  investigationId: string,
  reason: string,
): Promise<void> {
  await sendNotification({
    title: `Incident auto-linked to investigation`,
    body: `Incident ${incidentId.slice(0, 8)} linked to investigation ${investigationId.slice(0, 8)}\nReason: ${reason}`,
    priority: 3,
    tags: ['link'],
  })
}

/**
 * Investigation status transition (any)
 */
export async function notifyStatusChanged(
  investigationId: string,
  from: string,
  to: string,
  actor: string,
): Promise<void> {
  await sendNotification({
    title: `Investigation: ${from} → ${to}`,
    body: `Investigation ${investigationId.slice(0, 8)} status changed from ${from} to ${to} by ${actor}`,
    priority: to === 'active' ? 4 : 3,
    tags: ['status'],
  })
}

/**
 * High-confidence observable added with verdict: malicious
 */
export async function notifyMaliciousObservable(
  investigationId: string,
  observable: string,
  category: string,
  confidence: number,
): Promise<void> {
  await sendNotification({
    title: `🚨 Malicious observable detected`,
    body: `${category}: ${observable} (confidence: ${confidence}%)\nInvestigation: ${investigationId.slice(0, 8)}`,
    priority: 5,
    tags: ['warning', 'malware'],
  }, { urgent: true })
}

/**
 * New note added by Warden to an investigation
 */
export async function notifyWardenNote(
  investigationId: string,
  content: string,
): Promise<void> {
  await sendNotification({
    title: `Warden note on investigation`,
    body: `Investigation ${investigationId.slice(0, 8)}: ${content.slice(0, 200)}`,
    priority: 3,
    tags: ['memo'],
  })
}
