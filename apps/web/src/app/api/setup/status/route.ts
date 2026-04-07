export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET() {
  try {
    const setting = await prisma.systemSetting.findUnique({
      where: { key: 'setup.completed' },
    })
    return NextResponse.json({ completed: setting?.value === true })
  } catch {
    return NextResponse.json({ completed: false })
  }
}
