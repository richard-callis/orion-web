import { NextResponse } from 'next/server'
import { getCache } from '@/lib/k8s'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(getCache().pods)
}
