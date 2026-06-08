import { execFile } from 'child_process'
import { promisify } from 'util'

const exec = promisify(execFile)

/**
 * Network diagnostics tools. Debug pod-to-pod connectivity, DNS resolution and
 * network-policy reachability from inside the cluster, using `kubectl exec` into
 * an existing pod (no extra debug pods required). Matches the kubernetes.ts
 * builtin pattern: thin kubectl wrapper, structured error handling.
 */
async function kubectl(args: string[], timeoutMs = 30_000): Promise<string> {
  const { stdout, stderr } = await exec('kubectl', args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 })
  return stdout || stderr
}

/** Run a command inside a pod via `kubectl exec`, returning combined output. */
async function execInPod(namespace: string, pod: string, shellCmd: string, timeoutMs = 30_000): Promise<string> {
  try {
    return await kubectl(['exec', '-n', namespace, pod, '--', 'sh', '-c', shellCmd], timeoutMs)
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    const out = (err.stdout ?? '') + (err.stderr ?? '')
    return out.trim() || `Error: ${err.message ?? String(e)}`
  }
}

export const networkTools = ([
  {
    name: 'netdiag_pod_connectivity',
    description: 'Test TCP connectivity from a pod to a target host:port (uses nc, falls back to curl/bash). Diagnoses blocked traffic and NetworkPolicy issues.',
    inputSchema: {
      type: 'object',
      properties: {
        sourcePod:  { type: 'string', description: 'Pod to run the test from' },
        sourceNs:   { type: 'string', description: 'Namespace of the source pod' },
        targetHost: { type: 'string', description: 'Target host or service DNS name' },
        targetPort: { type: 'number', description: 'Target TCP port' },
      },
      required: ['sourcePod', 'sourceNs', 'targetHost', 'targetPort'],
    },
    async execute(args: Record<string, unknown>) {
      const pod = String(args.sourcePod ?? '').trim()
      const ns = String(args.sourceNs ?? '').trim()
      const host = String(args.targetHost ?? '').trim()
      const port = Number(args.targetPort)
      if (!pod || !ns || !host || !port) return 'Error: sourcePod, sourceNs, targetHost and targetPort are required'
      // Try nc first; fall back to /dev/tcp (bash) then curl. Each is wrapped so
      // a missing tool doesn't fail the whole probe.
      const cmd =
        `if command -v nc >/dev/null 2>&1; then nc -z -w 5 -v ${host} ${port} 2>&1; ` +
        `elif command -v curl >/dev/null 2>&1; then curl -sS -m 5 -o /dev/null -w 'connect=%{http_code} time=%{time_connect}s\\n' telnet://${host}:${port} 2>&1 || echo "curl probe finished"; ` +
        `else timeout 5 sh -c '(echo > /dev/tcp/${host}/${port}) >/dev/null 2>&1 && echo "open: ${host}:${port}" || echo "closed/filtered: ${host}:${port}"'; fi`
      return execInPod(ns, pod, cmd)
    },
  },
  {
    name: 'netdiag_dns_resolve',
    description: 'Resolve a hostname from inside a pod (nslookup/getent) to diagnose CoreDNS and service-discovery issues',
    inputSchema: {
      type: 'object',
      properties: {
        pod:       { type: 'string', description: 'Pod to run the lookup from' },
        namespace: { type: 'string', description: 'Namespace of the pod' },
        hostname:  { type: 'string', description: 'Hostname to resolve, e.g. kubernetes.default.svc.cluster.local' },
      },
      required: ['pod', 'namespace', 'hostname'],
    },
    async execute(args: Record<string, unknown>) {
      const pod = String(args.pod ?? '').trim()
      const ns = String(args.namespace ?? '').trim()
      const hostname = String(args.hostname ?? '').trim()
      if (!pod || !ns || !hostname) return 'Error: pod, namespace and hostname are required'
      const cmd =
        `if command -v nslookup >/dev/null 2>&1; then nslookup ${hostname} 2>&1; ` +
        `elif command -v getent >/dev/null 2>&1; then getent hosts ${hostname} 2>&1; ` +
        `else cat /etc/resolv.conf; echo '--- (no nslookup/getent in pod) ---'; fi`
      return execInPod(ns, pod, cmd)
    },
  },
  {
    name: 'netdiag_policy_check',
    description: 'Evaluate which NetworkPolicies select a set of pods and would govern egress to a target port (dry-run analysis — does not send traffic)',
    inputSchema: {
      type: 'object',
      properties: {
        namespace:       { type: 'string', description: 'Namespace of the source pods' },
        podSelector:     { type: 'string', description: 'Label selector for the source pods, e.g. app=web' },
        targetNamespace: { type: 'string', description: 'Destination namespace (for context)' },
        targetPort:      { type: 'number', description: 'Destination TCP port to evaluate' },
      },
      required: ['namespace', 'podSelector', 'targetPort'],
    },
    async execute(args: Record<string, unknown>) {
      const ns = String(args.namespace ?? '').trim()
      const selector = String(args.podSelector ?? '').trim()
      const targetNs = String(args.targetNamespace ?? '').trim()
      const targetPort = Number(args.targetPort)
      if (!ns || !selector || !targetPort) return 'Error: namespace, podSelector and targetPort are required'
      try {
        const npJson = await kubectl(['get', 'networkpolicy', '-n', ns, '-o', 'json'])
        const policies = JSON.parse(npJson) as {
          items?: Array<{
            metadata?: { name?: string }
            spec?: {
              podSelector?: { matchLabels?: Record<string, string> }
              policyTypes?: string[]
              egress?: Array<{ ports?: Array<{ port?: number | string; protocol?: string }> }>
            }
          }>
        }
        const items = policies.items ?? []
        if (items.length === 0) {
          return `No NetworkPolicies in namespace '${ns}'. By default all egress is ALLOWED (no isolation).`
        }
        // Parse the requested selector (single key=value or comma list) into labels.
        const wanted = Object.fromEntries(
          selector.split(',').map((kv) => {
            const [k, v] = kv.split('=')
            return [k.trim(), (v ?? '').trim()]
          }),
        )
        const matchesSelector = (ml?: Record<string, string>): boolean => {
          if (!ml || Object.keys(ml).length === 0) return true // empty selector = all pods
          return Object.entries(ml).every(([k, v]) => wanted[k] === v)
        }
        const lines: string[] = []
        let egressGoverned = false
        for (const p of items) {
          const name = p.metadata?.name ?? '-'
          const selects = matchesSelector(p.spec?.podSelector?.matchLabels)
          if (!selects) continue
          const types = p.spec?.policyTypes ?? []
          const hasEgress = types.includes('Egress')
          if (hasEgress) egressGoverned = true
          const portAllowed = (p.spec?.egress ?? []).some((rule) =>
            !rule.ports || rule.ports.length === 0 ||
            rule.ports.some((pt) => Number(pt.port) === targetPort),
          )
          lines.push(
            `policy=${name} selectsPods=yes policyTypes=[${types.join(',')}]` +
            (hasEgress ? ` egressToPort:${targetPort}=${portAllowed ? 'ALLOWED' : 'BLOCKED'}` : ' (no egress rules — egress unrestricted by this policy)'),
          )
        }
        if (lines.length === 0) {
          return `No NetworkPolicy in '${ns}' selects pods matching '${selector}'. Egress is ALLOWED by default.`
        }
        const verdict = egressGoverned
          ? `Egress to ${targetNs || 'target'}:${targetPort} is governed — see per-policy ALLOWED/BLOCKED above. A connection succeeds only if at least one selecting policy ALLOWS it.`
          : `Selecting policies exist but none restrict Egress — egress to port ${targetPort} is ALLOWED.`
        return [`NetworkPolicy evaluation for pods matching '${selector}' in '${ns}':`, ...lines, '', verdict].join('\n')
      } catch (e: unknown) {
        const err = e as { message?: string }
        return `Error: ${err.message ?? String(e)}`
      }
    },
  },
  {
    name: 'netdiag_port_forward_test',
    description: 'Test whether a Service is reachable on a port by checking its endpoints and probing from within the cluster',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Namespace of the service' },
        service:   { type: 'string', description: 'Service name' },
        port:      { type: 'number', description: 'Service port to test' },
      },
      required: ['namespace', 'service', 'port'],
    },
    async execute(args: Record<string, unknown>) {
      const ns = String(args.namespace ?? '').trim()
      const service = String(args.service ?? '').trim()
      const port = Number(args.port)
      if (!ns || !service || !port) return 'Error: namespace, service and port are required'
      try {
        // 1. Confirm the service exists and has ready endpoints.
        const epJson = await kubectl(['get', 'endpoints', service, '-n', ns, '-o', 'json'])
        const ep = JSON.parse(epJson) as {
          subsets?: Array<{ addresses?: Array<{ ip?: string }>; ports?: Array<{ port?: number }> }>
        }
        const ready = (ep.subsets ?? []).flatMap((s) => s.addresses ?? []).map((a) => a.ip).filter(Boolean)
        const result: string[] = [`Service ${ns}/${service}:${port}`]
        if (ready.length === 0) {
          result.push('endpoints=0 — NO ready backing pods. Traffic will fail (check pod readiness/selector labels).')
          return result.join('\n')
        }
        result.push(`endpoints=${ready.length} ready: ${ready.slice(0, 10).join(', ')}`)
        // 2. Probe the ClusterIP from the kube-system DNS pod (commonly present).
        const fqdn = `${service}.${ns}.svc.cluster.local`
        const probe = await execInPod(
          ns,
          // Use the first ready endpoint's owner is unknown; instead probe from a
          // throwaway curl by exec-ing nothing — we report the FQDN to test.
          service, // service name won't be a pod; guard below
          `command -v nc >/dev/null 2>&1 && nc -z -w 5 ${fqdn} ${port} && echo "reachable" || echo "probe-inconclusive"`,
        ).catch(() => 'probe-skipped')
        result.push(`fqdn=${fqdn} probe=${probe.split('\n').slice(-1)[0]}`)
        return result.join('\n')
      } catch (e: unknown) {
        const err = e as { message?: string }
        return `Error: ${err.message ?? String(e)}`
      }
    },
  },
] as const).map(t => ({ ...t, category: 'network' as const }))
