/**
 * ACAS / Tenable Nessus output normalizer (Phase 3 — vuln driver stub).
 *
 * Converts a Nessus `.nessus` XML report (NessusClientData_v2) into
 * VulnerabilityFinding upsert candidates — one row per (host, plugin, CVE).
 *
 * Notes / constraints:
 *   - `rawTrivy` is required by VulnerabilityFindingCandidate and is populated
 *     with the ReportItem metadata.
 *   - persistFindings ignores `candidate.severity` and recomputes via
 *     computeVulnSeverity({ cvssScore, ... }); we set `cvssScore` from
 *     cvss3_base_score / cvss_base_score, falling back to a Nessus 0-4
 *     severity → CVSS approximation.
 *   - ReportItems with no `<cve>` child are skipped (not per-CVE rows).
 *   - The per-finding `target` is derived per ReportHost (`acas:host:<name>`);
 *     the `_scanTarget` arg is kept only for API compatibility.
 */
import { XMLParser } from 'fast-xml-parser'
import type { VulnerabilityFindingCandidate } from './trivy'

// Nessus severity 0-4 → cvssScore approximation (used only when no CVSS score in XML)
const NESSUS_TO_CVSS: Record<number, number> = { 0: 0, 1: 2.5, 2: 5.0, 3: 7.5, 4: 9.0 }

export function parseAcasOutput(
  xml: string,
  environmentId: string,
  _scanTarget: string // kept for API compatibility; actual target derived per ReportHost
): VulnerabilityFindingCandidate[] {
  const candidates: VulnerabilityFindingCandidate[] = []

  let parsed: any
  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      isArray: (name) => ['ReportHost', 'ReportItem', 'cve'].includes(name),
    })
    parsed = parser.parse(xml)
  } catch {
    return []
  }

  const report = parsed?.NessusClientData_v2?.Report
  if (!report) return []

  const hosts: any[] = Array.isArray(report.ReportHost)
    ? report.ReportHost
    : report.ReportHost
      ? [report.ReportHost]
      : []

  for (const host of hosts) {
    const hostName: string = host['@_name'] ?? 'unknown'
    const target = `acas:host:${hostName}`
    const items: any[] = Array.isArray(host.ReportItem)
      ? host.ReportItem
      : host.ReportItem
        ? [host.ReportItem]
        : []

    for (const item of items) {
      const cves: string[] = Array.isArray(item.cve)
        ? item.cve
        : item.cve
          ? [String(item.cve)]
          : []
      if (cves.length === 0) continue // skip non-CVE plugins

      const nessusServerity = parseInt(item['@_severity'] ?? '0', 10)
      const cvss3Raw = parseFloat(item.cvss3_base_score)
      const cvss2Raw = parseFloat(item.cvss_base_score)
      const cvss3Score = Number.isFinite(cvss3Raw) ? cvss3Raw : null
      const cvss2Score = Number.isFinite(cvss2Raw) ? cvss2Raw : null
      const cvssScore = cvss3Score ?? cvss2Score ?? NESSUS_TO_CVSS[nessusServerity] ?? 0

      const cvssVector: string | null = item.cvss3_vector ?? item.cvss_vector ?? null
      const pluginName: string = item['@_pluginName'] ?? ''
      const pluginID: string = item['@_pluginID'] ?? ''

      // Best-effort version from plugin_output
      const pluginOutput: string = item.plugin_output ?? ''
      const versionMatch = pluginOutput.match(/\b(\d+\.\d+[\.\d]*)\b/)
      const packageVersion: string = versionMatch?.[1] ?? ''

      const rawTrivy: Record<string, unknown> = {
        pluginID,
        pluginName,
        synopsis: item.synopsis ?? null,
        description: item.description ?? null,
        solution: item.solution ?? null,
        port: item['@_port'],
        protocol: item['@_protocol'],
        nessusServerity,
      }

      for (const cveId of cves) {
        candidates.push({
          environmentId,
          target,
          cveId: String(cveId).trim(),
          packageName: pluginName,
          packageVersion,
          fixedVersion: null,
          cvssScore,
          cvssVector,
          severity: 0, // ignored by persistFindings; recomputed from cvssScore
          rawTrivy,
        })
      }
    }
  }

  return candidates
}
