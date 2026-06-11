import { NextRequest, NextResponse } from 'next/server'
import { coreApi } from '@/lib/k8s'
import { requireServiceAuth } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  await requireServiceAuth(req)
  const { searchParams } = new URL(req.url)
  const type  = searchParams.get('type')   // e.g. "Warning"
  const limit = parseInt(searchParams.get('limit') ?? '100', 10)

  try {
    const res = await coreApi.listEventForAllNamespaces()
    let items: any[] = res.body?.items ?? (res as any).items ?? []

    if (type) items = items.filter((e: any) => e.type === type)

    items = items
      .sort((a: any, b: any) => {
        const ta = a.lastTimestamp instanceof Date ? a.lastTimestamp.getTime() : new Date(a.lastTimestamp ?? 0).getTime()
        const tb = b.lastTimestamp instanceof Date ? b.lastTimestamp.getTime() : new Date(b.lastTimestamp ?? 0).getTime()
        return tb - ta
      })
      .slice(0, limit)

    return NextResponse.json(items)
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
