import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireWizardSession } from '@/lib/setup-guard'
import { ensureSystemAgents } from '@/lib/seed-system-agents'
import { ensureSystemEpic } from '@/lib/seed-system-epic'

export async function POST(req: NextRequest) {
  if (!await requireWizardSession(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  await prisma.systemSetting.upsert({
    where: { key: 'setup.completed' },
    update: { value: true },
    create: { key: 'setup.completed', value: true },
  })

  // Invalidate setup token — cannot be reused
  await prisma.systemSetting.delete({ where: { key: 'setup.token' } }).catch(() => {})

  // Seed system agents (Alpha, Veritas, Planner, Pulse) as Novas + imported Agents
  await ensureSystemAgents()

  // Seed System epic + Health / Operations / Maintenance features + chatrooms
  await ensureSystemEpic()

  const res = NextResponse.json({ ok: true })
  res.cookies.delete('__orion_wizard')
  return res
}
