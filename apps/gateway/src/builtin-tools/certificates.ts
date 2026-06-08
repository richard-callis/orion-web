/**
 * cert-manager integration tools for ORION Gateway.
 *
 * Provides visibility and control over TLS certificates managed by cert-manager.
 * All operations use kubectl against Certificate, Issuer, and ClusterIssuer CRDs.
 *
 * Registered for GATEWAY_TYPE=cluster.
 */
import { execFile } from 'child_process'
import { promisify } from 'util'

const exec = promisify(execFile)

async function kubectl(args: string[], timeoutMs = 30_000): Promise<string> {
  const { stdout, stderr } = await exec('kubectl', args, { timeout: timeoutMs })
  return stdout || stderr
}

/** Parse an ISO-8601 expiry string into a human-readable "X days" label. */
function expiryLabel(notAfter: string): string {
  const ms = new Date(notAfter).getTime() - Date.now()
  const days = Math.floor(ms / 86_400_000)
  if (days < 0) return `EXPIRED ${Math.abs(days)}d ago`
  if (days === 0) return 'expires TODAY'
  return `expires in ${days}d`
}

export const certificatesTools = ([
  {
    name: 'cert_list',
    description: 'List all cert-manager Certificate resources with expiry dates, status (Ready/NotReady), and issuer reference',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Namespace to list certificates in (omit for all namespaces)' },
      },
    },
    async execute(args: Record<string, unknown>) {
      try {
        const cmdArgs = ['get', 'certificates', '-o', 'json']
        if (args.namespace) cmdArgs.push('-n', String(args.namespace))
        else cmdArgs.push('-A')
        const raw = await kubectl(cmdArgs)
        const list = JSON.parse(raw) as { items?: any[] }
        const items = list.items ?? []
        if (items.length === 0) return 'No Certificate resources found'

        const lines = [`Found ${items.length} certificate(s):\n`]
        for (const cert of items) {
          const ns = cert.metadata?.namespace ?? '?'
          const name = cert.metadata?.name ?? '?'
          const issuerRef = cert.spec?.issuerRef ?? {}
          const issuer = `${issuerRef.kind ?? 'Issuer'}/${issuerRef.name ?? '?'}`
          const dnsNames = (cert.spec?.dnsNames ?? []).join(', ') || '(none)'

          // Determine readiness from status conditions
          const conditions: any[] = cert.status?.conditions ?? []
          const readyCond = conditions.find((c: any) => c.type === 'Ready')
          const ready = readyCond?.status === 'True' ? 'Ready' : 'NotReady'
          const reason = readyCond?.reason ? ` (${readyCond.reason})` : ''

          // Expiry from status.notAfter
          const notAfter = cert.status?.notAfter as string | undefined
          const expiry = notAfter ? expiryLabel(notAfter) : 'unknown expiry'

          lines.push(`  ${ns}/${name}`)
          lines.push(`    Status:  ${ready}${reason}`)
          lines.push(`    Expiry:  ${expiry}${notAfter ? ` (${notAfter})` : ''}`)
          lines.push(`    Issuer:  ${issuer}`)
          lines.push(`    DNS:     ${dnsNames}`)
          lines.push('')
        }
        return lines.join('\n')
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  },

  {
    name: 'cert_describe',
    description: 'Get detailed information about a specific cert-manager Certificate: DNS names, expiry, last renewal time, and all status conditions',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Namespace of the certificate' },
        name:      { type: 'string', description: 'Certificate resource name' },
      },
      required: ['namespace', 'name'],
    },
    async execute(args: Record<string, unknown>) {
      try {
        const ns = String(args.namespace)
        const name = String(args.name)
        const raw = await kubectl(['get', 'certificate', name, '-n', ns, '-o', 'json'])
        const cert = JSON.parse(raw)

        const issuerRef = cert.spec?.issuerRef ?? {}
        const dnsNames: string[] = cert.spec?.dnsNames ?? []
        const secretName = cert.spec?.secretName ?? '?'
        const renewBefore = cert.spec?.renewBefore ?? '?'
        const duration = cert.spec?.duration ?? '?'

        const notAfter = cert.status?.notAfter as string | undefined
        const notBefore = cert.status?.notBefore as string | undefined
        const renewalTime = cert.status?.renewalTime as string | undefined
        const lastRenewal = cert.status?.lastSuccessfulRenewal ?? cert.status?.lastUpdateTime

        const conditions: any[] = cert.status?.conditions ?? []
        const condLines = conditions.map((c: any) =>
          `  ${c.type}: ${c.status} — ${c.reason ?? ''}: ${c.message ?? ''}`
        )

        const lines = [
          `Certificate: ${ns}/${name}`,
          ``,
          `Spec:`,
          `  DNS names:    ${dnsNames.join(', ') || '(none)'}`,
          `  Secret:       ${secretName}`,
          `  Duration:     ${duration}`,
          `  Renew before: ${renewBefore}`,
          `  Issuer:       ${issuerRef.kind ?? 'Issuer'}/${issuerRef.name ?? '?'} (${issuerRef.group ?? 'cert-manager.io'})`,
          ``,
          `Status:`,
          `  Not before:     ${notBefore ?? 'unknown'}`,
          `  Not after:      ${notAfter ? `${notAfter} (${expiryLabel(notAfter)})` : 'unknown'}`,
          `  Renewal time:   ${renewalTime ?? 'unknown'}`,
          `  Last renewal:   ${lastRenewal ?? 'unknown'}`,
          ``,
          `Conditions:`,
          condLines.length > 0 ? condLines.join('\n') : '  (none)',
        ]
        return lines.join('\n')
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  },

  {
    name: 'cert_renew',
    description: 'Trigger manual renewal of a cert-manager Certificate by deleting its TLS Secret — cert-manager will automatically re-issue',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Namespace of the certificate' },
        name:      { type: 'string', description: 'Certificate resource name' },
      },
      required: ['namespace', 'name'],
    },
    async execute(args: Record<string, unknown>) {
      try {
        const ns = String(args.namespace)
        const certName = String(args.name)

        // Look up the secretName from the Certificate spec
        const raw = await kubectl(['get', 'certificate', certName, '-n', ns, '-o', 'jsonpath={.spec.secretName}'])
        const secretName = raw.trim()
        if (!secretName) return `Error: Certificate ${ns}/${certName} has no .spec.secretName`

        // Delete the secret — cert-manager detects the deletion and re-issues
        const out = await kubectl(['delete', 'secret', secretName, '-n', ns, '--ignore-not-found=true'])
        return [
          `Triggered renewal for ${ns}/${certName}`,
          `  Deleted TLS Secret: ${secretName}`,
          `  cert-manager will automatically re-issue. Monitor with: cert_describe namespace=${ns} name=${certName}`,
          out.trim() ? `\nkubectl output: ${out.trim()}` : '',
        ].join('\n')
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  },

  {
    name: 'cert_list_issuers',
    description: 'List ClusterIssuers and Issuers with their ready status and any error conditions',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Namespace to list Issuers in (omit for all namespaces). ClusterIssuers are always included.' },
      },
    },
    async execute(args: Record<string, unknown>) {
      try {
        const lines: string[] = []

        // ClusterIssuers are cluster-scoped
        try {
          const raw = await kubectl(['get', 'clusterissuers', '-o', 'json'])
          const list = JSON.parse(raw) as { items?: any[] }
          const items = list.items ?? []
          if (items.length > 0) {
            lines.push(`ClusterIssuers (${items.length}):`)
            for (const issuer of items) {
              const name = issuer.metadata?.name ?? '?'
              const conditions: any[] = issuer.status?.conditions ?? []
              const readyCond = conditions.find((c: any) => c.type === 'Ready')
              const ready = readyCond?.status === 'True' ? 'Ready' : 'NotReady'
              const reason = readyCond?.reason ? ` (${readyCond.reason})` : ''
              const msg = readyCond?.message ? `: ${readyCond.message.slice(0, 100)}` : ''
              lines.push(`  ${name}: ${ready}${reason}${msg}`)
            }
            lines.push('')
          }
        } catch {
          lines.push('ClusterIssuers: (not available — cert-manager may not be installed)')
          lines.push('')
        }

        // Namespaced Issuers
        const issuerArgs = ['get', 'issuers', '-o', 'json']
        if (args.namespace) issuerArgs.push('-n', String(args.namespace))
        else issuerArgs.push('-A')
        try {
          const raw = await kubectl(issuerArgs)
          const list = JSON.parse(raw) as { items?: any[] }
          const items = list.items ?? []
          if (items.length > 0) {
            lines.push(`Issuers (${items.length}):`)
            for (const issuer of items) {
              const ns = issuer.metadata?.namespace ?? '?'
              const name = issuer.metadata?.name ?? '?'
              const conditions: any[] = issuer.status?.conditions ?? []
              const readyCond = conditions.find((c: any) => c.type === 'Ready')
              const ready = readyCond?.status === 'True' ? 'Ready' : 'NotReady'
              const reason = readyCond?.reason ? ` (${readyCond.reason})` : ''
              lines.push(`  ${ns}/${name}: ${ready}${reason}`)
            }
          } else {
            lines.push('Issuers: (none found)')
          }
        } catch {
          lines.push('Issuers: (not available)')
        }

        return lines.join('\n') || 'No issuers found'
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  },

  {
    name: 'cert_check_expiring',
    description: 'List all certificates expiring within N days (default 30), sorted by urgency. Useful for proactive renewal monitoring.',
    inputSchema: {
      type: 'object',
      properties: {
        days:      { type: 'number', description: 'Warn about certs expiring within this many days (default 30)' },
        namespace: { type: 'string', description: 'Namespace to check (omit for all namespaces)' },
      },
    },
    async execute(args: Record<string, unknown>) {
      try {
        const thresholdDays = Math.max(1, Math.min(365, Number(args.days ?? 30)))
        const thresholdMs = thresholdDays * 86_400_000

        const cmdArgs = ['get', 'certificates', '-o', 'json']
        if (args.namespace) cmdArgs.push('-n', String(args.namespace))
        else cmdArgs.push('-A')
        const raw = await kubectl(cmdArgs)
        const list = JSON.parse(raw) as { items?: any[] }
        const items = list.items ?? []

        type CertEntry = { ns: string; name: string; notAfter: Date; daysLeft: number; ready: string }
        const expiring: CertEntry[] = []
        const now = Date.now()

        for (const cert of items) {
          const notAfterStr = cert.status?.notAfter as string | undefined
          if (!notAfterStr) continue
          const notAfter = new Date(notAfterStr)
          const ms = notAfter.getTime() - now
          if (ms > thresholdMs) continue // not expiring soon

          const conditions: any[] = cert.status?.conditions ?? []
          const readyCond = conditions.find((c: any) => c.type === 'Ready')
          const ready = readyCond?.status === 'True' ? 'Ready' : 'NotReady'
          expiring.push({
            ns:       cert.metadata?.namespace ?? '?',
            name:     cert.metadata?.name ?? '?',
            notAfter,
            daysLeft: Math.floor(ms / 86_400_000),
            ready,
          })
        }

        if (expiring.length === 0) {
          return `No certificates expiring within ${thresholdDays} days. Total checked: ${items.length}`
        }

        expiring.sort((a, b) => a.daysLeft - b.daysLeft)

        const lines = [
          `${expiring.length} certificate(s) expiring within ${thresholdDays} days (of ${items.length} total):\n`,
        ]
        for (const c of expiring) {
          const urgency = c.daysLeft < 0 ? '🔴 EXPIRED' : c.daysLeft <= 7 ? '🔴 CRITICAL' : c.daysLeft <= 14 ? '🟠 WARNING' : '🟡 EXPIRING'
          lines.push(`  ${urgency} ${c.ns}/${c.name}`)
          lines.push(`    Expires: ${c.notAfter.toISOString()} (${expiryLabel(c.notAfter.toISOString())})`)
          lines.push(`    Status:  ${c.ready}`)
          lines.push('')
        }
        return lines.join('\n')
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  },
] as const).map(t => ({ ...t, category: 'cluster-ops' as const }))
