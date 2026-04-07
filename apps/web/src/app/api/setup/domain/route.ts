import { NextRequest, NextResponse } from 'next/server'
import { writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { prisma } from '@/lib/db'
import { requireWizardSession } from '@/lib/setup-guard'

const COREDNS_DIR = process.env.COREDNS_DIR ?? '/etc/coredns-managed'

function generateZoneFile(domain: string, managementIp: string): string {
  const serial = new Date().toISOString().replace(/\D/g, '').slice(0, 10)
  return `; ${domain} zone file — managed by ORION, do not edit manually
$ORIGIN ${domain}.
$TTL 60

@   IN  SOA  ns1.${domain}. admin.${domain}. (
        ${serial}  ; serial
        3600        ; refresh
        900         ; retry
        604800      ; expire
        60          ; minimum TTL
    )

    IN  NS   ns1.${domain}.

; Management node
ns1   IN  A  ${managementIp}
orion IN  A  ${managementIp}
gitea IN  A  ${managementIp}
vault IN  A  ${managementIp}
`
}

function generateCorefile(internalDomain: string): string {
  return `. {
    forward . 1.1.1.1 8.8.8.8
    cache 30
    errors
    log
    reload
}

${internalDomain} {
    file /etc/coredns/zones/${internalDomain}.db
    errors
    log
}
`
}

export async function POST(req: NextRequest) {
  if (!await requireWizardSession(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { internalDomain, publicDomain, managementIp } = await req.json()

  if (!internalDomain?.trim()) {
    return NextResponse.json({ error: 'Internal domain is required' }, { status: 400 })
  }
  if (!managementIp?.trim()) {
    return NextResponse.json({ error: 'Management IP is required' }, { status: 400 })
  }

  const domain = internalDomain.trim().toLowerCase()
  const ip = managementIp.trim()

  try {
    // Ensure zones directory exists
    const zonesDir = path.join(COREDNS_DIR, 'zones')
    if (!existsSync(zonesDir)) {
      await mkdir(zonesDir, { recursive: true })
    }

    // Write zone file
    await writeFile(
      path.join(zonesDir, `${domain}.db`),
      generateZoneFile(domain, ip),
      'utf8'
    )

    // Write Corefile (CoreDNS reload plugin picks this up within 30s)
    await writeFile(
      path.join(COREDNS_DIR, 'Corefile'),
      generateCorefile(domain),
      'utf8'
    )
  } catch (err) {
    console.error('[setup/domain] Failed to write CoreDNS config:', err)
    return NextResponse.json(
      { error: 'Failed to write DNS configuration. Check COREDNS_DIR mount.' },
      { status: 500 }
    )
  }

  // Persist settings
  const settings = [
    { key: 'domain.internal', value: domain },
    { key: 'domain.public', value: publicDomain?.trim() ?? '' },
    { key: 'network.managementIp', value: ip },
  ]

  await prisma.$transaction(
    settings.map(({ key, value }) =>
      prisma.systemSetting.upsert({
        where: { key },
        update: { value },
        create: { key, value },
      })
    )
  )

  return NextResponse.json({ ok: true })
}
