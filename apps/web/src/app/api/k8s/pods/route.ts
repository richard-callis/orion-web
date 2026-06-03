import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { getCache } from '@/lib/k8s'

export const dynamic = 'force-dynamic'

export async function GET() {
  // Cluster state (pod list, IPs, node assignments) is admin-only.
  // Previously had no in-handler auth — only relied on middleware session gate.
  try { await requireAdmin() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return NextResponse.json(getCache().pods)
}
