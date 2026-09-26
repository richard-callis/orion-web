import type { McpToolConfig } from './orion-client.js'
import { quote, validatePackageName } from './lib/shell-quote.js'
import { run } from './lib/run.js'
import { safeFetch } from './lib/ssrf.js'

const HTTP_TOOL_TIMEOUT_MS = 30_000
const HTTP_TOOL_MAX_BYTES = 1024 * 1024

/**
 * Validate a user-defined shell template at load time.
 *
 * quote() wraps each argument in single quotes, which is only safe when the
 * `{placeholder}` sits OUTSIDE any quotes in the template:
 *   echo "{x}"  →  echo "'$(id)'"   — $(id) still expands inside "…"
 *   echo '{x}'  →  echo ''$(id)''   — the value lands unquoted
 * Returns an error message, or null when the template is safe.
 */
export function validateShellTemplate(command: string): string | null {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (ch === '\\' && !inSingle) { i++; continue }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue }
    if (ch === '{' && (inSingle || inDouble)) {
      const m = /^\{(\w+)\}/.exec(command.slice(i))
      if (m) {
        return `placeholder {${m[1]}} is inside ${inSingle ? 'single' : 'double'} quotes — ` +
          'remove the surrounding quotes; arguments are quoted automatically'
      }
    }
  }
  if (inSingle || inDouble) return 'template has an unterminated quote'
  return null
}

/**
 * Verify that binaries a shell tool depends on are present.
 *
 * Previously this ran `apk add` at request time. That never worked in the
 * non-root image (uid 1001) and let tool definitions from the DB mutate the
 * container, so it now only checks and reports what to add to the Dockerfile.
 */
async function ensurePackages(packages: string[]): Promise<void> {
  for (const pkg of packages) {
    if (!validatePackageName(pkg)) {
      throw new Error(
        `Invalid package name '${pkg}' — must match: ^[a-zA-Z][a-zA-Z0-9._+-]*$ (max 127 chars)`
      )
    }
    const binaryName = pkg.split('-').pop() ?? pkg  // e.g. "nmap-ncat" → "ncat"
    try {
      await run('sh', ['-c', `command -v ${quote(binaryName)}`], { timeoutMs: 5_000 })
    } catch {
      throw new Error(
        `Tool requires '${pkg}' which is not installed in the gateway container. ` +
        `Add "RUN apk add --no-cache ${pkg}" to the gateway Dockerfile and redeploy.`
      )
    }
  }
}

/**
 * Execute a tool based on its execType and execConfig.
 * Returns a string result (stdout/response body).
 */
export async function runTool(tool: McpToolConfig, args: Record<string, unknown>): Promise<string> {
  switch (tool.execType) {
    case 'builtin':
      throw new Error(`Built-in tool ${tool.name} must be registered via the builtin-tools registry, not runTool()`)

    case 'shell': {
      const command = tool.execConfig?.command as string | undefined
      if (!command) throw new Error(`Tool ${tool.name} has no execConfig.command`)
      const templateErr = validateShellTemplate(command)
      if (templateErr) throw new Error(`Tool ${tool.name} has an unsafe command template: ${templateErr}`)

      const packages = tool.execConfig?.packages as string[] | undefined
      if (packages?.length) await ensurePackages(packages)

      const requiredParams = (tool.inputSchema?.required as string[] | undefined) ?? []

      // SOC2: [H-005] Every argument is single-quoted via quote(); validateShellTemplate
      // guarantees placeholders are outside quotes so the quoting cannot be broken.
      const interpolated = command.replace(/\{(\w+)\}/g, (_, k) => {
        const val = args[k]
        if (val === undefined) {
          if (requiredParams.includes(k)) throw new Error(`Missing required argument: ${k}`)
          return '' // optional param not provided — substitute empty string
        }
        return quote(String(val))
      })
      const { stdout, stderr } = await run('sh', ['-c', interpolated], { timeoutMs: 30_000 })
      return stdout || stderr
    }

    case 'http': {
      const url = tool.execConfig?.url as string | undefined
      if (!url) throw new Error(`Tool ${tool.name} has no execConfig.url`)
      const interpolated = url.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(String(args[k] ?? '')))
      const method = ((tool.execConfig?.method as string | undefined) ?? 'GET').toUpperCase()
      // SOC2: CR-004 — SSRF protection. safeFetch pins the validated IP, re-validates
      // every redirect hop, and enforces a timeout and a body size cap.
      const res = await safeFetch(interpolated, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method !== 'GET' && method !== 'HEAD' ? JSON.stringify(args) : undefined,
        timeoutMs: HTTP_TOOL_TIMEOUT_MS,
        maxBytes: HTTP_TOOL_MAX_BYTES,
      })
      return res.body
    }

    default:
      throw new Error(`Unknown execType: ${tool.execType}`)
  }
}
