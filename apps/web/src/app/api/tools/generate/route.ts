import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

/**
 * POST /api/tools/generate
 * Use the configured Ollama/LLM to generate a tool definition from a plain-language description.
 * Returns { name, description, command, inputSchema, execType }
 */
export async function POST(req: NextRequest) {
  const body = await req.json()
  const { description, environmentType } = body as { description?: string; environmentType?: string }
  if (!description?.trim()) return NextResponse.json({ error: 'description is required' }, { status: 400 })

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

  const systemPrompt = `You are a tool definition assistant for an infrastructure management platform. ${envContext}
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
- packages: list any Alpine Linux (apk) packages needed that may not be pre-installed. Use exact Alpine package names (e.g. "nmap", "curl", "jq", "bind-tools", "iputils"). Leave empty array [] if only standard tools are used (kubectl, docker, sh, grep, etc.)
- Keep it simple and focused on exactly what was asked`

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

    // Build JSON Schema from parameters
    const params = parsed.parameters ?? {}
    const properties: Record<string, { type: string; description?: string }> = {}
    const required: string[] = []
    for (const [k, v] of Object.entries(params)) {
      properties[k] = { type: v.type ?? 'string', description: v.description }
      if (v.required !== false) required.push(k)
    }
    const inputSchema = { type: 'object', properties, required }

    const execConfig: Record<string, unknown> = { command: parsed.command }
    if (parsed.packages?.length) execConfig.packages = parsed.packages

    return NextResponse.json({
      name:        parsed.name,
      description: parsed.description,
      command:     parsed.command,
      packages:    parsed.packages ?? [],
      inputSchema,
      execType:    'shell',
      execConfig,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Generation failed: ${msg}` }, { status: 500 })
  }
}
