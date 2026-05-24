/**
 * Vulnerability scanner job (Phase 3 PR13).
 *
 * Two entry points:
 *
 *   - runDailyScan():
 *       At 02:00 daily — scans every running image in every env + K8s
 *       workloads + the Orion host's own packages.
 *
 *   - runEventTriggeredScan():
 *       Every 60s — picks up `docker.image.pull` SecurityEvents that
 *       haven't been scanned yet and triggers a Trivy scan for the
 *       pulled image. Hooks directly onto Phase 1's host-agent /
 *       Phase 2's Falco docker.image.pull events.
 *
 * Both go through:
 *   1. Call Trivy via gateway tool (trivy_scan_image / _k8s / _host).
 *   2. Parse output via normalize/trivy.ts.
 *   3. Enrich CVEs (KEV catalog, EPSS, NVD).
 *   4. Apply attack-vector severity formula.
 *   5. Upsert VulnerabilityFinding.
 *   6. Emit SecurityEvent on new findings or severity escalation.
 *   7. Detect fixes (existing finding with fixedVersion now installed).
 */
import { prisma } from '@/lib/db'
import { GatewayClient } from '@/lib/agent-runner/gateway-client'
import {
  parseTrivyImageOutput,
  parseTrivyK8sOutput,
  type VulnerabilityFindingCandidate,
} from '@/lib/security/normalize/trivy'
import {
  fetchKevCatalog,
  enrichEpss,
  enrichNvd,
  computeVulnSeverity,
} from '@/lib/security/cve-enrichment'

const EVENT_TRIGGERED_LOOKBACK_HOURS = 6

export interface ScanResult {
  environmentId: string
  target: string
  findingsCreated: number
  findingsEscalated: number
  findingsFixed: number
  errors: string[]
}

/**
 * Daily scan entry point. Iterates all envs (+ host) and scans them.
 * Returns per-target results.
 */
export async function runDailyScan(): Promise<ScanResult[]> {
  const results: ScanResult[] = []

  // 1. Refresh the KEV cache up front so all scans in this pass share it.
  const kev = await fetchKevCatalog()

  // 2. Per-env scans.
  const envs = await prisma.environment.findMany({
    where: { status: 'connected' },
    select: { id: true, type: true, gatewayUrl: true, gatewayToken: true },
  })

  for (const env of envs) {
    if (!env.gatewayUrl) continue
    const client = new GatewayClient(env.gatewayUrl, env.gatewayToken ?? '')

    // List running images via the existing kubectl/docker tools.
    let images: string[] = []
    try {
      images = await listRunningImages(client, env.type as 'cluster' | 'docker')
    } catch (err) {
      results.push({
        environmentId: env.id,
        target: 'list_images',
        findingsCreated: 0,
        findingsEscalated: 0,
        findingsFixed: 0,
        errors: [String(err)],
      })
      continue
    }

    for (const image of images) {
      results.push(await scanImage(client, env.id, image, kev))
    }

    if (env.type === 'cluster') {
      results.push(await scanK8sMisconfigs(client, env.id))
    }
  }

  // 3. Host scan — runs via the localhost gateway.
  const localhost = await prisma.environment.findFirst({
    where: { name: 'localhost' },
    select: { id: true, gatewayUrl: true, gatewayToken: true },
  })
  if (localhost?.gatewayUrl) {
    const client = new GatewayClient(localhost.gatewayUrl, localhost.gatewayToken ?? '')
    results.push(await scanHost(client, localhost.id, kev))
  }

  return results
}

/**
 * Event-triggered scan: 60s loop that scans new image pulls. "Already
 * scanned" is tracked via SecurityEvent.scannedAt (added in migration 18) —
 * indexed by (type, scannedAt) so the candidate query is cheap and the
 * tracking column self-prunes when the underlying event is deleted via
 * Phase 1's retention job.
 */
export async function runEventTriggeredScan(): Promise<ScanResult[]> {
  const results: ScanResult[] = []
  const since = new Date(Date.now() - EVENT_TRIGGERED_LOOKBACK_HOURS * 60 * 60 * 1000)

  // Candidates: pull events from the last lookback window that we haven't
  // marked as scanned yet. The (type, scannedAt) index makes the IN+IS NULL
  // filter cheap.
  const candidates = await prisma.securityEvent.findMany({
    where: {
      type: { in: ['docker.image.pull', 'docker.image.pull.unknown_registry'] },
      createdAt: { gte: since },
      scannedAt: null,
    },
    select: { id: true, environmentId: true, rawEvent: true },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })

  if (candidates.length === 0) return results

  const kev = await fetchKevCatalog()
  const now = new Date()

  for (const event of candidates) {
    const image = extractImageFromPullEvent(event.rawEvent as Record<string, unknown> | null)

    if (!image || !event.environmentId) {
      // Mark scanned-but-skipped so we don't keep re-probing malformed events.
      await prisma.securityEvent.update({
        where: { id: event.id },
        data: { scannedAt: now },
      }).catch(() => {})
      continue
    }

    const env = await prisma.environment.findUnique({
      where: { id: event.environmentId },
      select: { id: true, gatewayUrl: true, gatewayToken: true },
    })
    if (!env?.gatewayUrl) continue

    const client = new GatewayClient(env.gatewayUrl, env.gatewayToken ?? '')
    const result = await scanImage(client, env.id, image, kev)
    results.push(result)

    // Mark scanned regardless of scan outcome — a failed scan is "we tried,
    // don't retry every minute." Real retry strategy would be a separate
    // backoff system; for now one-shot is acceptable.
    await prisma.securityEvent.update({
      where: { id: event.id },
      data: { scannedAt: new Date() },
    }).catch(() => {})
  }

  return results
}

// ── Scan helpers ─────────────────────────────────────────────────────────────

async function scanImage(
  client: GatewayClient,
  environmentId: string,
  image: string,
  kev: { cves: Set<string>; dueDates: Map<string, string> }
): Promise<ScanResult> {
  const target = `image:${image}`
  const result: ScanResult = {
    environmentId,
    target,
    findingsCreated: 0,
    findingsEscalated: 0,
    findingsFixed: 0,
    errors: [],
  }
  let trivyOutput: string
  try {
    trivyOutput = await client.executeTool('trivy_scan_image', { image })
  } catch (e) {
    result.errors.push(`trivy_scan_image: ${e instanceof Error ? e.message : String(e)}`)
    return result
  }

  const candidates = parseTrivyImageOutput(trivyOutput, environmentId, target)
  await persistFindings(candidates, kev, result)
  return result
}

async function scanHost(
  client: GatewayClient,
  environmentId: string,
  kev: { cves: Set<string>; dueDates: Map<string, string> }
): Promise<ScanResult> {
  const target = 'host'
  const result: ScanResult = {
    environmentId,
    target,
    findingsCreated: 0,
    findingsEscalated: 0,
    findingsFixed: 0,
    errors: [],
  }
  let out: string
  try {
    out = await client.executeTool('trivy_scan_host', {})
  } catch (e) {
    result.errors.push(`trivy_scan_host: ${e instanceof Error ? e.message : String(e)}`)
    return result
  }
  const candidates = parseTrivyImageOutput(out, environmentId, target)
  await persistFindings(candidates, kev, result)
  return result
}

async function scanK8sMisconfigs(
  client: GatewayClient,
  environmentId: string
): Promise<ScanResult> {
  const target = 'k8s:cluster'
  const result: ScanResult = {
    environmentId,
    target,
    findingsCreated: 0,
    findingsEscalated: 0,
    findingsFixed: 0,
    errors: [],
  }
  let out: string
  try {
    out = await client.executeTool('trivy_scan_k8s', {})
  } catch (e) {
    result.errors.push(`trivy_scan_k8s: ${e instanceof Error ? e.message : String(e)}`)
    return result
  }
  const drafts = parseTrivyK8sOutput(out, environmentId)
  for (const draft of drafts) {
    try {
      const existing = await prisma.securityEvent.findFirst({
        where: { source: 'trivy_k8s', dedupKey: hashKey(draft.dedupKey) },
        select: { id: true },
      })
      if (existing) continue
      await prisma.securityEvent.create({
        data: {
          environmentId: draft.environmentId,
          type: draft.type,
          source: draft.source,
          severity: draft.severity,
          title: draft.title,
          description: draft.description,
          rawEvent: draft.rawEvent as any,
          dedupKey: hashKey(draft.dedupKey),
          firstSeen: new Date(),
          lastSeen: new Date(),
        },
      })
      result.findingsCreated++
    } catch (e) {
      result.errors.push(`k8s misconfig persist: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return result
}

async function persistFindings(
  candidates: VulnerabilityFindingCandidate[],
  kev: { cves: Set<string>; dueDates: Map<string, string> },
  result: ScanResult
) {
  if (candidates.length === 0) return

  // EPSS enrichment is batched cheaply over all CVEs in this scan.
  const cveIds = Array.from(new Set(candidates.map((c) => c.cveId)))
  const epssMap = await enrichEpss(cveIds)

  for (const c of candidates) {
    try {
      const epss = epssMap.get(c.cveId)
      const isKev = kev.cves.has(c.cveId)
      const kevDue = kev.dueDates.get(c.cveId) ?? null

      // NVD enrichment only for HIGH/CRITICAL (CVSS >= 7) to stay under quota.
      let attackVector: string | null = null
      let cvssVector: string | null = c.cvssVector
      let attackComplexity: string | null = null
      if ((c.cvssScore ?? 0) >= 7.0) {
        const nvd = await enrichNvd(c.cveId)
        if (nvd) {
          attackVector = nvd.attackVector
          cvssVector = cvssVector ?? nvd.cvssVector
          attackComplexity = nvd.attackComplexity
        }
      }

      const severity = computeVulnSeverity({
        cvssScore: c.cvssScore,
        isKev,
        epssScore: epss?.score ?? null,
        attackVector,
        isInternetFacing: false, // TODO: derive from Environment.monitoringConfig in a follow-up
      })

      const existing = await prisma.vulnerabilityFinding.findUnique({
        where: {
          environmentId_target_cveId_packageName: {
            environmentId: c.environmentId,
            target: c.target,
            cveId: c.cveId,
            packageName: c.packageName,
          },
        },
      })

      // Fix detection: existing open finding, and installed pkg version now
      // matches the fixedVersion → mark fixed and emit vuln.fixed event.
      if (
        existing &&
        existing.status === 'open' &&
        existing.fixedVersion &&
        c.packageVersion === existing.fixedVersion
      ) {
        await prisma.vulnerabilityFinding.update({
          where: { id: existing.id },
          data: { status: 'fixed', fixedAt: new Date() },
        })
        await prisma.securityEvent.create({
          data: {
            environmentId: c.environmentId,
            type: 'vuln.fixed',
            source: 'trivy',
            severity: 10,
            title: `Vulnerability fixed: ${c.cveId} in ${c.packageName}`,
            description: `Package ${c.packageName} on ${c.target} updated to fixed version ${existing.fixedVersion}.`,
            rawEvent: { cveId: c.cveId, package: c.packageName, fixedVersion: existing.fixedVersion } as any,
            dedupKey: hashKey(`vuln.fixed|${c.environmentId}|${c.target}|${c.cveId}|${c.packageName}`),
            firstSeen: new Date(),
            lastSeen: new Date(),
          },
        }).catch(() => {})
        result.findingsFixed++
        continue
      }

      const upserted = await prisma.vulnerabilityFinding.upsert({
        where: {
          environmentId_target_cveId_packageName: {
            environmentId: c.environmentId,
            target: c.target,
            cveId: c.cveId,
            packageName: c.packageName,
          },
        },
        update: {
          packageVersion: c.packageVersion,
          fixedVersion: c.fixedVersion,
          cvssScore: c.cvssScore,
          cvssVector,
          attackVector,
          attackComplexity,
          epssScore: epss?.score ?? null,
          epssPercentile: epss?.percentile ?? null,
          isKev,
          kevDueDate: kevDue ? new Date(kevDue) : null,
          severity,
          status: 'open',
          rawTrivy: c.rawTrivy as any,
        },
        create: {
          environmentId: c.environmentId,
          target: c.target,
          packageName: c.packageName,
          packageVersion: c.packageVersion,
          fixedVersion: c.fixedVersion,
          cveId: c.cveId,
          cvssScore: c.cvssScore,
          cvssVector,
          attackVector,
          attackComplexity,
          epssScore: epss?.score ?? null,
          epssPercentile: epss?.percentile ?? null,
          isKev,
          kevDueDate: kevDue ? new Date(kevDue) : null,
          severity,
          status: 'open',
          rawTrivy: c.rawTrivy as any,
        },
      })

      if (!existing) {
        // New finding — emit vuln.new event.
        await prisma.securityEvent.create({
          data: {
            environmentId: c.environmentId,
            type: 'vuln.new',
            source: 'trivy',
            severity,
            title: `New CVE: ${c.cveId} in ${c.packageName} on ${c.target}`,
            description: `Trivy detected ${c.cveId} (CVSS ${c.cvssScore ?? '?'}, KEV=${isKev}, EPSS=${epss?.score ?? '?'})`,
            rawEvent: { cveId: c.cveId, package: c.packageName, isKev, epss: epss?.score } as any,
            dedupKey: hashKey(`vuln.new|${upserted.id}`),
            firstSeen: new Date(),
            lastSeen: new Date(),
          },
        }).catch(() => {})
        result.findingsCreated++
      } else if (severity > existing.severity) {
        // Escalation — emit vuln.escalated event.
        await prisma.securityEvent.create({
          data: {
            environmentId: c.environmentId,
            type: 'vuln.escalated',
            source: 'trivy',
            severity,
            title: `Escalated CVE: ${c.cveId} (severity ${existing.severity} → ${severity})`,
            description: `Enrichment promoted severity (KEV=${isKev}, EPSS=${epss?.score ?? '?'}).`,
            rawEvent: { cveId: c.cveId, prevSeverity: existing.severity, newSeverity: severity, isKev } as any,
            dedupKey: hashKey(`vuln.escalated|${upserted.id}|${severity}`),
            firstSeen: new Date(),
            lastSeen: new Date(),
          },
        }).catch(() => {})
        result.findingsEscalated++
      }
    } catch (e) {
      result.errors.push(`finding ${c.cveId}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

// ── Misc helpers ─────────────────────────────────────────────────────────────

async function listRunningImages(
  client: GatewayClient,
  kind: 'cluster' | 'docker'
): Promise<string[]> {
  if (kind === 'cluster') {
    const out = await client.executeTool('kubectl_get_pods', {})
    try {
      const data = JSON.parse(out)
      const items = Array.isArray(data?.items) ? data.items : []
      const set = new Set<string>()
      for (const pod of items) {
        for (const c of pod?.spec?.containers ?? []) {
          if (typeof c?.image === 'string') set.add(c.image)
        }
      }
      return Array.from(set)
    } catch {
      return []
    }
  } else {
    const out = await client.executeTool('docker_ps', {})
    // docker_ps tool returns one line per container. Extract IMAGE column.
    const set = new Set<string>()
    for (const line of out.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/)
      if (cols.length >= 2) set.add(cols[1])
    }
    return Array.from(set)
  }
}

function extractImageFromPullEvent(raw: Record<string, unknown> | null): string | null {
  if (!raw) return null
  // The Phase 1/2 docker.image.pull event records the image in either
  // output_fields.container_image or rawEvent.image.
  const fields = (raw as any).output_fields ?? (raw as any).fields ?? {}
  const candidates = [
    typeof fields['container.image'] === 'string' ? fields['container.image'] : null,
    typeof fields.container_image === 'string' ? fields.container_image : null,
    typeof (raw as any).image === 'string' ? (raw as any).image : null,
  ]
  for (const c of candidates) {
    if (c) return c
  }
  return null
}

function hashKey(input: string): string {
  // Stable, opaque. No crypto required at the call site — the input string
  // already encodes the identity-determining fields.
  let h = 5381
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h) ^ input.charCodeAt(i)
  }
  return `vuln_${(h >>> 0).toString(16)}_${input.length}_${input.slice(-32)}`
}
