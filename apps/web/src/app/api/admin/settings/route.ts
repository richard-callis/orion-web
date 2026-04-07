import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET() {
  const rows = await prisma.systemSetting.findMany()
  const result: Record<string, unknown> = {}
  for (const row of rows) {
    result[row.key] = row.value
  }
  return NextResponse.json(result)
}

export async function PATCH(req: NextRequest) {
  const body: Record<string, unknown> = await req.json()

  const ops = Object.entries(body).map(([key, value]) =>
    prisma.systemSetting.upsert({
      where: { key },
      update: { value: value as Parameters<typeof prisma.systemSetting.create>[0]['data']['value'] },
      create: { key, value: value as Parameters<typeof prisma.systemSetting.create>[0]['data']['value'] },
    })
  )

  await prisma.$transaction(ops)
  return NextResponse.json({ ok: true })
}
