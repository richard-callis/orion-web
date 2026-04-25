import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { sanitizeError } from '@/lib/errors'

// Allowed shell commands per environment type (allowlist)
const ALLOWED_COMMAND_PREFIXES = {
  cluster: [
    'kubectl', 'helm', 'kubectl-kustomize', 'kubens', 'kubectx',
  ],
  docker: [
    'docker', 'docker-compose', 'docker compose', 'ctr', 'nerdctl',
  ],
  localhost: [
    'kubectl', 'helm', 'docker', 'docker-compose', 'docker compose',
    'sh', 'bash', 'curl', 'wget', 'jq', 'yq', 'tar', 'gzip', 'gunzip',
    'grep', 'sed', 'awk', 'sort', 'uniq', 'wc', 'head', 'tail', 'cat',
    'ls', 'find', 'df', 'du', 'free', 'top', 'ps', 'uptime', 'hostname',
    'ip', 'ifconfig', 'ss', 'nc', 'ncat', 'nmap', 'ping', 'traceroute',
    'dig', 'nslookup', 'host', 'systemctl', 'journalctl', 'chmod', 'chown',
    'mkdir', 'rm', 'cp', 'mv', 'ln', 'touch', 'zip', 'unzip', 'rsync',
    'apt-get', 'apk', 'yum', 'dnf', 'pip', 'npm', 'yarn', 'pnpm',
  ],
  generic: [
    'sh', 'bash', 'curl', 'wget', 'jq', 'yq', 'grep', 'sed', 'awk',
    'ls', 'find', 'cat', 'echo', 'test', '[', 'true', 'false',
  ],
}

/**
 * Sanitize a generated shell command — strip dangerous patterns.
 * Returns sanitized command or throws if it contains untrusted patterns.
 */
function sanitizeCommand(command: string, envType: string): string {
  const trimmed = command.trim()

  // Block common injection patterns even if individual chars are "safe"
  const dangerousPatterns = [
    /\|\|/,    // OR chain
    /&&/,      // AND chain
    /\$\(/,    // command substitution
    /`[^`]*`/, // backtick substitution
    /;[ \t]*\w/, // semicolon + command
    />[ \t]*/, // output redirect (allowed in some contexts)
    /<([ \t]|&)/, // input redirect
    /\/etc\//,  // reading system files
    /\/proc\//, // proc filesystem
    /\/dev\//,  // device files
    /rm\s+-rf/, // mass deletion
    /dd\s+/,    // disk operations
    /mknod/,   // device creation
    /mkfifo/,  // named pipe creation
    /socat/,   // network utility (common in reverse shells)
    /nc\s+(-[elp]|-[lv]|-[c])/, // netcat patterns
    /python.*-c/, // python -c code execution
    /perl.*-e/,  // perl -e code execution
    /ruby.*-e/,  // ruby -e code execution
    /node.*-e/,  // node -e code execution
    /base64\s+-d/, // base64 decode
    /\bxargs\b/, // xargs (often used in chains)
  ]

  for (const pattern of dangerousPatterns) {
    if (pattern.test(trimmed)) {
      throw new Error(`Generated command contains unsafe pattern: ${trimmed.slice(0, 80)}`)
    }
  }

  // If command has a prefix, verify it's allowed for this environment type
  const firstWord = trimmed.split(/\s+/)[0] ?? ''
  const allowed = ALLOWED_COMMAND_PREFIXES[envType as keyof typeof ALLOWED_COMMAND_PREFIXES]
  if (allowed && !allowed.some(prefix => firstWord.startsWith(prefix))) {
    // Enforce: reject commands not on the allowlist for this environment
    throw new Error(`Command '${firstWord}' not allowed in '${envType}' environment. Allowed: ${allowed.join(', ')}`)
  }

  return trimmed
}

/**
 * Validate and sanitize package names from LLM output.
 * Returns sanitized package list or throws.
 */
function sanitizePackages(packages: string[]): string[] {
  const validPkgRegex = /^[a-zA-Z0-9][a-zA-Z0-9.+\-]*$/
  const sanitized: string[] = []
  for (const pkg of packages) {
    if (!validPkgRegex.test(pkg)) {
      throw new Error(`Invalid package name: ${pkg.slice(0, 50)}`)
    }
    if (pkg.length > 100) {
      throw new Error(`Package name too long: ${pkg.slice(0, 50)}`)
    }
    sanitized.push(pkg)
  }
  return sanitized
}

/**
 * POST /api/tools/generate
 * Use the configured Ollama/LLM to generate a tool definition from a plain-language description.
 * Returns { name, description, command, inputSchema, execType }
 */
export async function POST(req: NextRequest) {
  // SOC2: CR-005 — require authentication (LLM calls cost money, tools execute on gateway)
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const { description, environmentType } = body as { description?: string; environmentType?: string }

  // Validate description length
  if (!description?.trim()) return NextResponse.json({ error: 'description is required' }, { status: 400 })
  if (description.length > 500) {
    return NextResponse.json({ error: 'Description too long (max 500 characters)' }, { status: 400 })
  }

  // Validate description content (block obvious attack keywords)
  // Note: We rely on the command sanitization in sanitizeCommand() for the real defense
  if (/\b(exfil|reverse\s+shell|bind\s+shell|payload|backdoor)\b/i.test(description.trim())) {
    return NextResponse.json({ error: 'Description contains suspicious keywords' }, { status: 400 })
  }

  // Find an Ollama model to use
  const extModel = await prisma.externalModel.findFirst({
    where: { provider: 'ollama', enabled: true },
    orderBy: { createdAt: 'asc' },
  })
  if (!extModel?.baseUrl) {
    return NextResponse.json({ error: 'No Ollama model configured' }, { status: 503 })
  }

  const envContext = environmentType === 'docker'
    ? 'This is a Docker host environment. Tools run Docker CLI commands.'
    : environmentType === 'cluster'
    ? 'This is a Kubernetes cluster environment. Tools run kubectl commands.'
    : 'This is a generic remote environment.'

  // Hardened system prompt with explicit security instructions
  const systemPrompt = `You are a tool definition assistant for an infrastructure management platform. ${envContext}

SECURITY RULES:
- NEVER generate commands that read /etc/shadow, /etc/passwd, or any sensitive files
- NEVER generate commands that make outbound network requests to unknown hosts
- NEVER generate commands that use reverse shells, base64 encoding, or obfuscation
- NEVER generate commands that modify system configuration or install packages unnecessarily
- ONLY generate commands appropriate for the stated environment
- Commands should be read-only or safe read/write operations only
Respond ONLY with a valid JSON object — no markdown, no explanation, no code fences.`

  const userPrompt = `Generate a tool definition for: "${description.trim()}"

Return a JSON object with these exact fields:
{
  "name": "snake_case_tool_name",
  "description": "Clear one-sentence description of what the tool does",
  "command": "the shell command with {param_name} placeholders for any parameters",
  "packages": ["apk-package-name"],
  "parameters": {
    "param_name": { "type": "string", "description": "what this param is", "required": true }
  }
}

Rules:
- name must be snake_case, descriptive, no spaces
- command must be a real, safe shell command appropriate for the environment
- Use {param} placeholders for any variable inputs
- Only include parameters that the command actually uses
- packages: list any Alpine Linux (apk) packages needed that may not be pre-installed. Use exact Alpine package names. Leave empty array [] if only standard tools are used.
- Keep it simple and focused on exactly what was asked
- IMPORTANT: Only generate safe, read-only commands. No file system traversal, no outbound connections.`

  try {
    const res = await fetch(`${extModel.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: extModel.modelId,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt },
        ],
        stream: false,
      }),
      signal: AbortSignal.timeout((extModel.timeoutSecs ?? 60) * 1000),
    })
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`)

    const data = await res.json() as { message: { content: string } }
    let raw = data.message.content.trim()

    // Strip code fences if the model added them anyway
    raw = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim()

    const parsed = JSON.parse(raw) as {
      name: string
      description: string
      command: string
      packages?: string[]
      parameters?: Record<string, { type?: string; description?: string; required?: boolean }>
    }

    // Validate name (snake_case, alphanumeric + underscores, max 64 chars)
    const toolNameRegex = /^[a-z][a-z0-9_]*$/
    if (!toolNameRegex.test(parsed.name)) {
      throw new Error(`Invalid tool name: ${parsed.name.slice(0, 50)}`)
    }
    if (parsed.name.length > 64) {
      throw new Error('Tool name too long (max 64 characters)')
    }
    // Validate description length
    if (parsed.description.length > 200) {
      throw new Error('Description too long (max 200 characters)')
    }

    // Validate and sanitize the command
    const safeEnvType = (environmentType ?? 'generic') as string
    const sanitizedCommand = sanitizeCommand(parsed.command, safeEnvType)

    // Validate and sanitize package names
    const sanitizedPackages = parsed.packages?.length ? sanitizePackages(parsed.packages) : []

    // Build JSON Schema from parameters
    const params = parsed.parameters ?? {}
    const properties: Record<string, { type: string; description?: string }> = {}
    const required: string[] = []
    for (const [k, v] of Object.entries(params)) {
      properties[k] = { type: v.type ?? 'string', description: v.description }
      if (v.required !== false) required.push(k)
    }
    const inputSchema = { type: 'object', properties, required }

    const execConfig: Record<string, unknown> = { command: sanitizedCommand }
    if (sanitizedPackages.length) execConfig.packages = sanitizedPackages

    return NextResponse.json({
      name:        parsed.name,
      description: parsed.description,
      command:     sanitizedCommand,
      packages:    sanitizedPackages,
      inputSchema,
      execType:    'shell',
      execConfig,
    })
  } catch (err) {
    return NextResponse.json({ error: `Generation failed: ${sanitizeError(err)}` }, { status: 500 })
  }
}
