import { NextRequest, NextResponse } from 'next/server'
import { promises as dns } from 'dns'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

const PRIVATE_IP_PATTERNS = [
  /^127\./, /^10\./, /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^::1$/, /^::ffff:/i, /^fc00:/i, /^fe80:/i,
  /^0\.0\.0\.0$/,
]

function isPrivateIp(ip: string): boolean {
  return PRIVATE_IP_PATTERNS.some(p => p.test(ip))
}

async function isPrivateUrl(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true
    const { hostname } = parsed
    if (hostname === 'localhost' || hostname === '0.0.0.0') return true
    if (isPrivateIp(hostname)) return true
    // Resolve DNS and check all returned addresses to block encoded IPs and pre-DNS-rebinding
    const [v4, v6] = await Promise.all([
      dns.resolve4(hostname).catch(() => [] as string[]),
      dns.resolve6(hostname).catch(() => [] as string[]),
    ])
    return [...v4, ...v6].some(isPrivateIp)
  } catch { return true }
}

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  try { await requireAdmin() } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const channel = await prisma.notificationChannel.findUnique({ where: { id: params.id } })
  if (!channel) return NextResponse.json({ ok: false, error: 'Channel not found' }, { status: 404 })

  if (await isPrivateUrl(channel.webhookUrl)) {
    return NextResponse.json({ ok: false, error: 'Webhook URL targets a private/internal address' }, { status: 400 })
  }

  let payload: object

  if (channel.type === 'slack') {
    payload = {
      attachments: [{
        color: 'good',
        title: '✅ ORION Test Notification',
        text: `This is a test from channel *${channel.name}*. Your Slack integration is working!`,
        ts: Math.floor(Date.now() / 1000),
      }],
    }
  } else if (channel.type === 'discord') {
    payload = {
      embeds: [{
        title: '✅ ORION Test Notification',
        description: `This is a test from channel **${channel.name}**. Your Discord integration is working!`,
        color: 0x57F287,
        timestamp: new Date().toISOString(),
      }],
    }
  } else {
    payload = {
      event: 'test',
      channelName: channel.name,
      message: 'This is a test notification from ORION.',
      timestamp: new Date().toISOString(),
    }
  }

  try {
    const res = await fetch(channel.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return NextResponse.json({ ok: false, error: `Webhook returned ${res.status}: ${text.slice(0, 200)}` })
    }
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}
