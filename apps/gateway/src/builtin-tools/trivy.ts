/**
 * Trivy scan gateway tools (Phase 3 PR11).
 *
 * Three read-tier tools that shell out to the trivy CLI:
 *
 *   - trivy_scan_image: scan a container image by tag
 *   - trivy_scan_k8s:   scan all (or one namespace of) K8s workloads for
 *                       misconfigurations
 *   - trivy_scan_host:  scan the gateway's host OS packages (rootfs)
 *
 * All three return Trivy's JSON output as a string for the orion-web
 * scanner job (apps/web/src/jobs/security-scan-vulns.ts) to parse.
 *
 * Concurrency: a single in-process semaphore limits Trivy to ONE concurrent
 * scan per gateway. Multiple parallel scans cause OOM on smaller hosts —
 * Trivy holds the entire vulnerability DB in memory during the scan.
 *
 * Errors never throw — they return a string so the gateway's tool
 * dispatcher reports it back to the caller cleanly.
 */
import { promisify } from 'util'
import { execFile } from 'child_process'

const exec = promisify(execFile)

// ── Validation ──────────────────────────────────────────────────────────────

// Image refs: <registry>/<path>:<tag> or <path>:<tag> or <path>@<digest>.
// Conservative — no whitespace, no shell metachars. Trivy itself accepts more
// formats, but we lock down what crosses our trust boundary.
const IMAGE_REF_RE = /^[A-Za-z0-9._/:@\-]+$/

// K8s namespace names: DNS-1123 label.
const NAMESPACE_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/

// ── Single-scan semaphore ───────────────────────────────────────────────────

let activeScans = 0
const MAX_CONCURRENT_SCANS = 1

async function withScanSlot<T>(label: string, fn: () => Promise<T>): Promise<T | string> {
  if (activeScans >= MAX_CONCURRENT_SCANS) {
    return `Trivy busy — another scan is in progress (${label} queued elsewhere).`
  }
  activeScans++
  try {
    return await fn()
  } finally {
    activeScans--
  }
}

// ── Output guard ────────────────────────────────────────────────────────────

// Trivy can emit very large outputs (10MB+) for big images. Cap what we
// return to the caller — the gateway -> orion HTTP path has limits.
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024 // 8 MiB

function truncateOutput(s: string): string {
  if (Buffer.byteLength(s, 'utf8') <= MAX_OUTPUT_BYTES) return s
  // Return a structured error that orion can detect rather than corrupting JSON.
  return JSON.stringify({
    error: 'trivy_output_truncated',
    message: `Trivy output exceeded ${MAX_OUTPUT_BYTES} bytes — scan target too large or DB too verbose.`,
    bytes: Buffer.byteLength(s, 'utf8'),
  })
}

// ── Tool definitions ────────────────────────────────────────────────────────

const trivyToolDefs = ([
  {
    name: 'trivy_scan_image',
    description:
      'Scan a container image for known CVEs using Trivy. Returns Trivy JSON ' +
      'or an error string. First scan downloads the vulnerability DB — slow.',
    inputSchema: {
      type: 'object',
      required: ['image'],
      properties: {
        image: {
          type: 'string',
          description: 'Image ref: <registry>/<path>:<tag> or <path>@<digest>',
        },
      },
    },
    async execute(args: Record<string, unknown>) {
      const image = String(args.image ?? '')
      if (!image) return 'image arg is required'
      if (!IMAGE_REF_RE.test(image)) {
        return `Invalid image ref (no shell metachars; alphanumeric/-./:_@ only). Got: ${image.slice(0, 60)}`
      }
      return withScanSlot('image', async () => {
        try {
          const { stdout, stderr } = await exec(
            'trivy',
            ['image', '--format', 'json', '--quiet', '--no-progress', image],
            { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }
          )
          if (!stdout && stderr) return `trivy stderr: ${stderr.slice(0, 500)}`
          return truncateOutput(stdout)
        } catch (e: any) {
          return `trivy_scan_image error: ${(e?.stderr ?? e?.message ?? e).toString().slice(0, 500)}`
        }
      })
    },
  },

  {
    name: 'trivy_scan_k8s',
    description:
      'Scan K8s workloads for misconfigurations (privileged, host mounts, ' +
      'missing limits) via Trivy. Returns Trivy JSON or an error string.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: {
          type: 'string',
          description: 'Optional namespace; default --all-namespaces.',
        },
      },
    },
    async execute(args: Record<string, unknown>) {
      const ns = typeof args.namespace === 'string' && args.namespace.length > 0 ? args.namespace : ''
      if (ns && !NAMESPACE_RE.test(ns)) {
        return `Invalid namespace (DNS-1123 label only): ${ns}`
      }
      const trivyArgs = ['k8s', '--format', 'json', '--quiet']
      if (ns) trivyArgs.push('--namespace', ns)
      else trivyArgs.push('--all-namespaces')
      trivyArgs.push('cluster')

      return withScanSlot('k8s', async () => {
        try {
          const { stdout, stderr } = await exec('trivy', trivyArgs, {
            timeout: 180_000,
            maxBuffer: 16 * 1024 * 1024,
          })
          if (!stdout && stderr) return `trivy stderr: ${stderr.slice(0, 500)}`
          return truncateOutput(stdout)
        } catch (e: any) {
          return `trivy_scan_k8s error: ${(e?.stderr ?? e?.message ?? e).toString().slice(0, 500)}`
        }
      })
    },
  },

  {
    name: 'trivy_scan_host',
    description:
      'Scan the gateway host OS packages (rootfs / scan) for known CVEs. ' +
      'Returns Trivy JSON or an error string. Slow — full OS scan is ~5 min.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    async execute(_args: Record<string, unknown>) {
      return withScanSlot('host', async () => {
        try {
          const { stdout, stderr } = await exec(
            'trivy',
            ['rootfs', '--format', 'json', '--quiet', '--no-progress', '/'],
            { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 }
          )
          if (!stdout && stderr) return `trivy stderr: ${stderr.slice(0, 500)}`
          return truncateOutput(stdout)
        } catch (e: any) {
          return `trivy_scan_host error: ${(e?.stderr ?? e?.message ?? e).toString().slice(0, 500)}`
        }
      })
    },
  },
] as const).map((t) => ({ ...t, category: 'security' as const }))

export const trivyTools = trivyToolDefs
