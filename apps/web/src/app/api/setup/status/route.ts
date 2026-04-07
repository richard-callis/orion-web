export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET() {
  try {
    const [completed, internalDomain] = await Promise.all([
      prisma.systemSetting.findUnique({ where: { key: 'setup.completed' } }),
      prisma.systemSetting.findUnique({ where: { key: 'domain.internal' } }),
    ])
    return NextResponse.json({
      completed: completed?.value === true,
      internalDomain: internalDomain?.value ?? null,
    })
  } catch {
    return NextResponse.json({ completed: false, internalDomain: null })
  }
}
