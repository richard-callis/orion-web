/**
 * Notification dispatcher for Slack, Discord, and custom webhooks.
 * Called at key task lifecycle points in the worker.
 */

import { prisma } from './db'

export type NotificationEvent =
  | { type: 'task_completed'; taskId: string; taskTitle: string; agentId: string; agentName: string; durationMs?: number }
  | { type: 'task_failed';    taskId: string; taskTitle: string; agentId: string; agentName: string; error?: string }
  | { type: 'budget_exceeded'; agentId: string; agentName: string; reason: string }
  | { type: 'plan_approval_needed'; taskId: string; taskTitle: string; agentId: string; riskLevel: string }

function colorForEvent(type: NotificationEvent['type']): { slack: string; discord: number } {
  switch (type) {
    case 'task_completed':      return { slack: 'good',    discord: 0x57F287 }
    case 'task_failed':         return { slack: 'danger',  discord: 0xED4245 }
    case 'budget_exceeded':     return { slack: 'warning', discord: 0xFEE75C }
    case 'plan_approval_needed':return { slack: 'warning', discord: 0xFEE75C }
  }
}

function formatSlack(event: NotificationEvent): object {
  const { slack: color } = colorForEvent(event.type)
  let title: string
  let text: string

  switch (event.type) {
    case 'task_completed':
      title = `✅ Task Completed: ${event.taskTitle}`
      text = `Agent *${event.agentName}* completed the task${event.durationMs ? ` in ${Math.round(event.durationMs / 1000)}s` : ''}.`
      break
    case 'task_failed':
      title = `❌ Task Failed: ${event.taskTitle}`
      text = `Agent *${event.agentName}* failed the task.${event.error ? `\n\`\`\`${event.error.slice(0, 500)}\`\`\`` : ''}`
      break
    case 'budget_exceeded':
      title = `⚠️ Budget Exceeded`
      text = `Agent *${event.agentName}* hit a budget limit.\n${event.reason}`
      break
    case 'plan_approval_needed':
      title = `🔔 Plan Approval Needed: ${event.taskTitle}`
      text = `Agent *${event.agentName}* requires plan approval. Risk level: *${event.riskLevel}*.`
      break
  }

  return {
    attachments: [
      {
        color,
        title,
        text,
        ts: Math.floor(Date.now() / 1000),
      },
    ],
  }
}

function formatDiscord(event: NotificationEvent): object {
  const { discord: color } = colorForEvent(event.type)
  let title: string
  let description: string

  switch (event.type) {
    case 'task_completed':
      title = `✅ Task Completed: ${event.taskTitle}`
      description = `Agent **${event.agentName}** completed the task${event.durationMs ? ` in ${Math.round(event.durationMs / 1000)}s` : ''}.`
      break
    case 'task_failed':
      title = `❌ Task Failed: ${event.taskTitle}`
      description = `Agent **${event.agentName}** failed the task.${event.error ? `\n\`\`\`${event.error.slice(0, 500)}\`\`\`` : ''}`
      break
    case 'budget_exceeded':
      title = `⚠️ Budget Exceeded`
      description = `Agent **${event.agentName}** hit a budget limit.\n${event.reason}`
      break
    case 'plan_approval_needed':
      title = `🔔 Plan Approval Needed: ${event.taskTitle}`
      description = `Agent **${event.agentName}** requires plan approval. Risk level: **${event.riskLevel}**.`
      break
  }

  return {
    embeds: [
      {
        title,
        description,
        color,
        timestamp: new Date().toISOString(),
      },
    ],
  }
}

function formatWebhook(event: NotificationEvent): object {
  const base = {
    event: event.type,
    agentId: event.agentId,
    agentName: event.agentName,
    timestamp: new Date().toISOString(),
  }

  if (event.type === 'task_completed' || event.type === 'task_failed' || event.type === 'plan_approval_needed') {
    return { ...base, taskId: (event as any).taskId, taskTitle: (event as any).taskTitle }
  }

  return base
}

/**
 * Dispatch a notification event to all matching enabled channels.
 * Fire-and-forget: errors are logged but never thrown.
 */
export async function notify(event: NotificationEvent): Promise<void> {
  try {
    const channels = await prisma.notificationChannel.findMany({
      where: { enabled: true },
    })

    for (const channel of channels) {
      // Check event subscription
      let subscribedEvents: string[] = []
      try { subscribedEvents = JSON.parse(channel.events) } catch { continue }
      if (!subscribedEvents.includes(event.type)) continue

      // Check agent filter
      if (channel.agentFilter) {
        let allowedAgents: string[] = []
        try { allowedAgents = JSON.parse(channel.agentFilter) } catch {}
        const agentId = (event as any).agentId as string
        if (!allowedAgents.includes(agentId)) continue
      }

      // Build payload
      let payload: object
      if (channel.type === 'slack') {
        payload = formatSlack(event)
      } else if (channel.type === 'discord') {
        payload = formatDiscord(event)
      } else {
        payload = formatWebhook(event)
      }

      fetch(channel.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch((e: unknown) => {
        console.error(`[notifications] Failed to POST to channel "${channel.name}" (${channel.id}):`, e)
      })
    }
  } catch (e) {
    console.error('[notifications] Error dispatching notification:', e)
  }
}
