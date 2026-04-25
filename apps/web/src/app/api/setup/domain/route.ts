import { NextRequest, NextResponse } from 'next/server'
import { writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { prisma } from '@/lib/db'
import { requireWizardSession } from '@/lib/setup-guard'

const COREDNS_DIR = process.env.COREDNS_DIR ?? '/etc/coredns-managed'

// RFC 1035 domain name validation: labels separated by dots, each label
// 1-63 chars of [a-zA-Z0-9], labels cannot start/end with hyphen.
// Root "." is allowed.
const DOMAIN_RE = /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$|^\.?$/

function validateDomain(domain: string): string {
  if (!DOMAIN_RE.test(domain)) {
    throw new Error(
      'Invalid domain name — must be a valid RFC 1035 domain (e.g. "khalis.corp")'
    )
  }
  return domain
}

/** Resolve the final path and verify it is still under the intended base. */
function assertPathSafe(finalPath: string, baseDir: string): void {
  const resolved = path.resolve(baseDir, finalPath)
  if (!resolved.startsWith(path.resolve(baseDir))) {
    throw new Error('Path traversal detected — domain must not contain ".." or absolute paths')
  }
}

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
  if (publicDomain?.trim() && !DOMAIN_RE.test(publicDomain.trim().toLowerCase())) {
    return NextResponse.json(
      { error: 'Public domain must be a valid RFC 1035 domain (e.g. "khalisio.com")' },
      { status: 400 }
    )
  }

  const domain = internalDomain.trim().toLowerCase()
  const ip = managementIp.trim()

  // Validate domain name (RFC 1035) — prevents path traversal at source
  const validated = validateDomain(domain)
  if (validated !== domain) {
    return NextResponse.json(
      { error: 'Invalid domain name — must be a valid RFC 1035 domain (e.g. "khalis.corp")' },
      { status: 400 }
    )
  }

  try {
    // Ensure zones directory exists
    const zonesDir = path.join(COREDNS_DIR, 'zones')
    if (!existsSync(zonesDir)) {
      await mkdir(zonesDir, { recursive: true })
    }

    // Defense in depth: verify the resolved path is still under COREDNS_DIR
    const zoneFilePath = path.resolve(zonesDir, `${domain}.db`)
    assertPathSafe(zoneFilePath, COREDNS_DIR)

    // Write zone file
    await writeFile(
      zoneFilePath,
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
