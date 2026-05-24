/**
 * Trivy output normalizer (Phase 3 PR13).
 *
 * Converts a Trivy scan's JSON output into:
 *   - upsert candidates for VulnerabilityFinding (per-CVE-per-target rows)
 *   - SecurityEvent drafts for new/escalated/fixed findings (correlator hook)
 *
 * Trivy's output shape varies slightly between scan types:
 *   - image / rootfs: { Results: [ { Vulnerabilities: [...] } ] }
 *   - k8s:            { Resources: [ { Misconfigurations: [...] } ] }
 *
 * Misconfigurations become SecurityEvents directly (no VulnerabilityFinding
 * row — they aren't per-CVE).
 */

export interface TrivyVulnerability {
  VulnerabilityID: string
  PkgName: string
  InstalledVersion?: string
  FixedVersion?: string
  Severity?: string
  CVSS?: Record<string, { V3Score?: number; V2Score?: number; V3Vector?: string }>
  Title?: string
  Description?: string
}

export interface TrivyImageResult {
  Target?: string
  Vulnerabilities?: TrivyVulnerability[]
}

export interface TrivyImageOutput {
  Results?: TrivyImageResult[]
}

export interface TrivyMisconfiguration {
  ID: string
  Title: string
  Description?: string
  Severity?: string
  Resource?: string
}

export interface TrivyK8sResource {
  Namespace?: string
  Kind?: string
  Name?: string
  Misconfigurations?: TrivyMisconfiguration[]
}

export interface TrivyK8sOutput {
  Resources?: TrivyK8sResource[]
}

export interface VulnerabilityFindingCandidate {
  environmentId: string
  target: string
  packageName: string
  packageVersion: string
  fixedVersion: string | null
  cveId: string
  cvssScore: number | null
  cvssVector: string | null
  severity: number // base severity (CVSS*10); enrichment may raise it later
  rawTrivy: Record<string, unknown>
}

/**
 * Parse a Trivy image / rootfs JSON output into candidate rows.
 *
 * The caller is responsible for:
 *   - enriching each candidate (KEV / EPSS / NVD)
 *   - applying the final attack-vector formula
 *   - upserting + emitting SecurityEvents
 */
export function parseTrivyImageOutput(
  json: string,
  environmentId: string,
  target: string
): VulnerabilityFindingCandidate[] {
  let parsed: TrivyImageOutput
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  const candidates: VulnerabilityFindingCandidate[] = []
  for (const result of parsed.Results ?? []) {
    for (const vuln of result.Vulnerabilities ?? []) {
      if (!vuln.VulnerabilityID || !vuln.PkgName) continue
      const { score, vector } = extractCvss(vuln)
      candidates.push({
        environmentId,
        target,
        packageName: vuln.PkgName,
        packageVersion: vuln.InstalledVersion ?? '',
        fixedVersion: vuln.FixedVersion ?? null,
        cveId: vuln.VulnerabilityID,
        cvssScore: score,
        cvssVector: vector,
        severity: score !== null ? Math.round(score * 10) : 0,
        rawTrivy: vuln as unknown as Record<string, unknown>,
      })
    }
  }
  return candidates
}

/**
 * Parse a Trivy K8s scan output into MisconfigurationEvent drafts.
 *
 * These do NOT produce VulnerabilityFinding rows (they're not per-CVE).
 * They become SecurityEvent rows directly via the scanner job.
 */
export interface K8sMisconfigurationDraft {
  environmentId: string
  type: string
  source: 'trivy_k8s'
  severity: number
  title: string
  description: string | null
  rawEvent: Record<string, unknown>
  dedupKey: string
  sourceName: string
}

export function parseTrivyK8sOutput(
  json: string,
  environmentId: string
): K8sMisconfigurationDraft[] {
  let parsed: TrivyK8sOutput
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  const out: K8sMisconfigurationDraft[] = []
  for (const resource of parsed.Resources ?? []) {
    const namespace = resource.Namespace ?? 'default'
    const kind = resource.Kind ?? 'Unknown'
    const name = resource.Name ?? 'unknown'
    const sourceName = `${kind}/${name}`
    for (const m of resource.Misconfigurations ?? []) {
      if (!m.ID) continue
      out.push({
        environmentId,
        type: `trivy.${m.ID.toLowerCase()}`,
        source: 'trivy_k8s',
        severity: trivySeverityToScore(m.Severity),
        title: `${m.Title} (${kind}/${name})`,
        description: m.Description ?? null,
        rawEvent: { ...m, namespace, kind, name } as unknown as Record<string, unknown>,
        dedupKey: hashLike([environmentId, m.ID, namespace, kind, name]),
        sourceName,
      })
    }
  }
  return out
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractCvss(v: TrivyVulnerability): { score: number | null; vector: string | null } {
  if (!v.CVSS) return { score: null, vector: null }
  // Prefer NVD's score; fall back to Red Hat / GHSA / etc.
  const order = ['nvd', 'redhat', 'ghsa']
  for (const key of order) {
    const entry = v.CVSS[key]
    if (entry?.V3Score) return { score: entry.V3Score, vector: entry.V3Vector ?? null }
    if (entry?.V2Score) return { score: entry.V2Score, vector: null }
  }
  // Last resort: first available entry.
  for (const entry of Object.values(v.CVSS)) {
    if (entry?.V3Score) return { score: entry.V3Score, vector: entry.V3Vector ?? null }
    if (entry?.V2Score) return { score: entry.V2Score, vector: null }
  }
  return { score: null, vector: null }
}

function trivySeverityToScore(s?: string): number {
  switch ((s ?? '').toUpperCase()) {
    case 'CRITICAL': return 90
    case 'HIGH':     return 70
    case 'MEDIUM':   return 50
    case 'LOW':      return 25
    default:         return 10
  }
}

// Local hash that produces a deterministic string for dedup. We avoid pulling
// in crypto here so this file stays import-cheap; the scanner job will sha256
// the dedupKey before insert when needed.
function hashLike(parts: string[]): string {
  return parts.join('|')
}
