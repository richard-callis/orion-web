/**
 * GET /api/environments/:id/status
 * Returns diagnostic information about why a gateway might not be connected.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  const env = await prisma.environment.findUnique({
    where: { id: params.id },
    include: {
      _count: {
        select: { agents: true, tools: true },
      },
    },
  })

  if (!env) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const isConnected = !!(env.gatewayToken && env.gatewayUrl)
  const lastSeenAgo = env.lastSeen ? Math.round((Date.now() - env.lastSeen.getTime()) / 1000) : null
  const tokenAgeSeconds = env.gatewayToken ? 10 : 0 // We don't store token creation time, so use 0 if exists

  const diagnostics = {
    id: env.id,
    name: env.name,
    type: env.type,
    status: env.status,
    isConnected,
    gatewayUrl: env.gatewayUrl || null,
    hasGatewayToken: !!env.gatewayToken,
    lastSeen: env.lastSeen?.toISOString() || null,
    lastSeenSecondsAgo: lastSeenAgo,
    gatewayVersion: env.gatewayVersion || null,
    toolCount: env._count.tools,
    agentCount: env._count.agents,

    // Diagnostic messages
    diagnostics: [] as string[],
  }

  // Generate diagnostic messages
  if (!isConnected) {
    diagnostics.diagnostics.push('❌ Gateway not connected')
    if (!env.gatewayToken) {
      diagnostics.diagnostics.push('   • No gatewayToken: gateway has not successfully joined yet')
      diagnostics.diagnostics.push('   • Check the gateway pod logs: kubectl logs -n management -l app=orion-gateway-* -f')
    }
    if (!env.gatewayUrl) {
      diagnostics.diagnostics.push('   • No gatewayUrl: gateway could not determine its own address')
      diagnostics.diagnostics.push('   • This usually means node IP discovery failed (check gateway logs)')
    }
  } else if (lastSeenAgo && lastSeenAgo > 90) {
    diagnostics.diagnostics.push(`⚠️  Gateway heartbeat stale (${lastSeenAgo}s ago)`)
    diagnostics.diagnostics.push('   • Gateway may be dead or network connectivity is broken')
    diagnostics.diagnostics.push('   • Check: kubectl get pods -n management | grep orion-gateway')
  } else if (lastSeenAgo && lastSeenAgo > 60) {
    diagnostics.diagnostics.push(`✓ Gateway connected but heartbeat may be delayed (${lastSeenAgo}s ago)`)
  } else {
    diagnostics.diagnostics.push('✓ Gateway connected')
  }

  if (!diagnostics.diagnostics.length) {
    diagnostics.diagnostics.push('ℹ️ Status: OK')
  }

  return NextResponse.json(diagnostics)
}
