import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'

/**
 * GET /api/environments/:id/storage
 * Returns Longhorn storage volume information for the environment's cluster.
 */
export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    // TODO: Query Longhorn volumes from the cluster via kubeconfig
    // For now, return empty response
    return NextResponse.json({
      volumes: [],
      message: 'Storage integration coming soon',
    })
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch storage information' },
      { status: 500 }
    )
  }
}
