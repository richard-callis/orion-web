export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { createSession, listSessions, killSession } from '@/lib/terminal-sessions'
import { prisma } from '@/lib/db'

async function notifyTerminalAccess(userId: string, ip: string) {
  // 1. Write audit log
  await prisma.auditLog.create({
    data: {
      userId,
      action: 'terminal.open',
      target: 'admin-terminal',
      detail: { ip, at: new Date().toISOString() },
    },
  }).catch(() => {})

  // 2. Discord webhook — if configured in SystemSetting 'notifications.discord.webhook'
  try {
    const setting = await prisma.systemSetting.findUnique({
      where: { key: 'notifications.discord.webhook' },
    })
    const webhookUrl = setting?.value as string | undefined
    if (!webhookUrl) return

    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: '🖥️ Terminal accessed',
          color: 0xff5555,
          fields: [
            { name: 'User', value: userId, inline: true },
            { name: 'IP', value: ip || 'unknown', inline: true },
            { name: 'Time', value: new Date().toUTCString(), inline: false },
          ],
        }],
      }),
    })
  } catch { /* non-fatal */ }
}

export async function POST(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  const userId = (token?.sub as string | undefined) ?? 'unknown'
  const ip = req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? 'direct'

  const sessionId = createSession()
  console.log('[terminal] created session', sessionId, 'by', userId, 'from', ip)

  // Fire-and-forget — don't block the response
  notifyTerminalAccess(userId, ip)

  return NextResponse.json({ sessionId })
}

export async function GET() {
  return NextResponse.json(listSessions())
}

export async function DELETE(req: Request) {
  const { sessionId } = await req.json() as { sessionId?: string }
  if (sessionId) killSession(sessionId)
  return NextResponse.json({ ok: true })
}
