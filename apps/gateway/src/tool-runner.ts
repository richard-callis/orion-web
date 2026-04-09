import { execFile } from 'child_process'
import { promisify } from 'util'
import type { McpToolConfig } from './orion-client.js'

const exec = promisify(execFile)

/**
 * Ensure required packages are installed in the gateway container.
 * Uses `apk add` (Alpine) — falls back to a clear error if unavailable.
 */
async function ensurePackages(packages: string[]): Promise<void> {
  for (const pkg of packages) {
    // Check if the binary is already available
    const binaryName = pkg.split('-').pop() ?? pkg  // e.g. "nmap-ncat" → "ncat", "nmap" → "nmap"
    try {
      await exec('sh', ['-c', `which ${binaryName} || command -v ${binaryName}`], { timeout: 5_000 })
      // Already installed
    } catch {
      console.log(`[tool-runner] Package '${pkg}' not found — attempting auto-install via apk...`)
      try {
        const { stdout, stderr } = await exec('sh', ['-c', `apk add --no-cache ${pkg} 2>&1`], { timeout: 120_000 })
        console.log(`[tool-runner] Installed '${pkg}':`, (stdout || stderr).trim())
      } catch (installErr) {
        const msg = installErr instanceof Error ? installErr.message : String(installErr)
        throw new Error(
          `Tool requires '${pkg}' which is not installed in the gateway container.\n` +
          `Auto-install failed: ${msg}\n` +
          `To permanently fix: add RUN apk add --no-cache ${pkg} to the gateway Dockerfile and redeploy.`
        )
      }
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

      // Ensure required packages are installed before running
      const packages = tool.execConfig?.packages as string[] | undefined
      if (packages?.length) {
        await ensurePackages(packages)
      }

      // Determine which params are required (per inputSchema)
      const requiredParams = (tool.inputSchema?.required as string[] | undefined) ?? []

      // Substitute {arg_name} placeholders from the tool's arguments
      const interpolated = command.replace(/\{(\w+)\}/g, (_, k) => {
        const val = args[k]
        if (val === undefined) {
          if (requiredParams.includes(k)) throw new Error(`Missing required argument: ${k}`)
          return '' // optional param not provided — substitute empty string
        }
        // Basic safety: reject args containing shell metacharacters
        const str = String(val)
        if (/[;&|`$<>\\]/.test(str)) throw new Error(`Argument '${k}' contains disallowed characters`)
        return str
      })
      const { stdout, stderr } = await exec('sh', ['-c', interpolated], { timeout: 30_000 })
      return stdout || stderr
    }

    case 'http': {
      const url = tool.execConfig?.url as string | undefined
      if (!url) throw new Error(`Tool ${tool.name} has no execConfig.url`)
      // Substitute {arg_name} placeholders in the URL
      const interpolated = url.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(String(args[k] ?? '')))
      const method = (tool.execConfig?.method as string | undefined) ?? 'GET'
      const res = await fetch(interpolated, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method !== 'GET' ? JSON.stringify(args) : undefined,
      })
      return res.text()
    }

    default:
      throw new Error(`Unknown execType: ${tool.execType}`)
  }
}
