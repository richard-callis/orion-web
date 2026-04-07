import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireWizardSession } from '@/lib/setup-guard'

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

  const res = NextResponse.json({ ok: true })
  res.cookies.delete('__orion_wizard')
  return res
}
