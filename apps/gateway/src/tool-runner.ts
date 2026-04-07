import { execFile } from 'child_process'
import { promisify } from 'util'
import type { McpToolConfig } from './orion-client.js'

const exec = promisify(execFile)

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
      // Substitute {arg_name} placeholders from the tool's arguments
      const interpolated = command.replace(/\{(\w+)\}/g, (_, k) => {
        const val = args[k]
        if (val === undefined) throw new Error(`Missing required argument: ${k}`)
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
