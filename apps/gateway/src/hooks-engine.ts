/**
 * Hooks Engine for ORION Gateways.
 *
 * Manages reactive hooks that fire on infrastructure events (pod crashes, OOM kills,
 * disk full, ArgoCD degraded, tool execution). Hooks are fetched from ORION (NebulaInstances
 * of category "hook") and executed when their trigger conditions match.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'

import { OrionClient } from './orion-client.js'

const execFileAsync = promisify(execFile)

export type HookEvent = {
  type: 'pod_crashloop' | 'pod_oom' | 'node_disk_full' | 'sync_degraded' | 'tool_execution'
  payload: Record<string, unknown>
}

/**
 * Structured command templates — user/event data NEVER enters a shell string.
 * Each entry defines the binary and a function that builds argv from safe event data.
 * Adding a new allowed command requires adding a template here.
 */
const COMMAND_TEMPLATES: Record<
  string,
  { bin: string; args: (data: Record<string, string>) => string[] }
> = {
  'kubectl describe pod': {
    bin: 'kubectl',
    args: (d) => ['describe', 'pod', d.pod_name, '-n', d.namespace],
  },
  'kubectl logs': {
    bin: 'kubectl',
    args: (d) => ['logs', d.pod_name, '-n', d.namespace, '--previous', '--tail=50'],
  },
  'kubectl get nodes': {
    bin: 'kubectl',
    args: (_d) => ['get', 'nodes', '-o', 'wide'],
  },
  'kubectl get applications': {
    bin: 'kubectl',
    args: (_d) => ['get', 'applications', '-n', 'argocd', '-o', 'wide'],
  },
  'kubectl get pods': {
    bin: 'kubectl',
    args: (d) => ['get', 'pods', '-n', d.namespace, '-o', 'wide'],
  },
  'kubectl rollout restart': {
    bin: 'kubectl',
    args: (d) => ['rollout', 'restart', `deployment/${d.deployment}`, '-n', d.namespace],
  },
  'helm list': {
    bin: 'helm',
    args: (d) => ['list', '-n', d.namespace],
  },
  'df -h': {
    bin: 'df',
    args: (_d) => ['-h'],
  },
}

/**
 * Pattern for safe substitution values — kubernetes resource name characters only.
 * Prevents injection via event payload values.
 */
const SAFE_VALUE = /^[a-z0-9][a-z0-9\-\.]*$/i

function sanitizeEventData(data: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [k, v] of Object.entries(data)) {
    const str = String(v ?? '')
    if (str !== '' && !SAFE_VALUE.test(str)) {
      throw new Error(`Hook aborted: payload value for '${k}' contains unsafe characters: '${str}'`)
    }
    result[k] = str
  }
  return result
}

export class HooksEngine {
  private orion: OrionClient
  private hooks: Array<{ id: string; name: string; spec: any }> = []
  private interval: ReturnType<typeof setInterval> | null = null

  constructor(orion: OrionClient) {
    this.orion = orion
  }

  async start(environmentId: string): Promise<void> {
    // Poll for hook definitions from ORION
    this.interval = setInterval(async () => {
      await this.refresh(environmentId)
    }, 30000) // 30 second poll

    // Start event listeners
    this.startEventListeners()
  }

  async refresh(environmentId: string): Promise<void> {
    // Fetch active hooks from ORION via OrionClient.fetchNebula(environmentId)
    const response = await this.orion.fetchNebula(environmentId)
    this.hooks = (response as any).filter((h: any) => h.isInstalled && h.category === 'hook')
  }

  private startEventListeners(): void {
    // Listen for kubectl events, ArgoCD sync events, etc.
    // For now, implement a simple event dispatch
  }

  async handleEvent(event: HookEvent): Promise<void> {
    for (const hook of this.hooks) {
      const spec = JSON.parse(hook.spec)
      if (spec.triggerType !== event.type) continue

      // Match triggerFilter
      const filter = spec.triggerFilter || {}
      if (!this.matchesFilter(event, filter)) continue

      // Execute action
      await this.executeHook(hook, event, spec)
    }
  }

  private matchesFilter(event: HookEvent, filter: Record<string, unknown>): boolean {
    for (const [key, value] of Object.entries(filter)) {
      if ((event.payload as any)[key] !== value) return false
    }
    return true
  }

  private async executeHook(hook: any, event: HookEvent, spec: any): Promise<void> {
    const startTime = Date.now()
    const environmentId = (event.payload as any).environmentId
    let status = 'success'
    let output: string | undefined

    try {
      if (spec.actionType === 'run_shell_command') {
        // actionConfig.templateKey selects a structured command template by name.
        // Event data is passed as argv array elements — never interpolated into a shell string.
        output = await this.runStructuredCommand(spec.actionConfig.templateKey, event)
      } else if (spec.actionType === 'send_notification') {
        output = spec.actionConfig.message.replace(
          /{(\w+)}/g,
          (_: string, key: string) => String((event.payload as any)[key] ?? ''),
        )
      }
    } catch (err) {
      status = 'failed'
      output = err instanceof Error ? err.message : String(err)
    }

    // Report to ORION
    const durationMs = Date.now() - startTime
    await this.orion
      .reportHookExecution(environmentId, {
        nebulaId: hook.id,
        triggerEvent: event.type,
        triggerData: JSON.stringify(event.payload),
        actionType: spec.actionType,
        status,
        output,
        durationMs,
      })
      .catch(() => {})
  }

  /**
   * Execute a command using a structured template lookup.
   *
   * User/event data is passed directly as execFile argv array elements — it never
   * enters a shell string, so no shell injection is possible regardless of content.
   * CodeQL taint analysis will not flag argv array elements passed to execFile.
   *
   * @param templateKey - Key into COMMAND_TEMPLATES (e.g. "kubectl describe pod")
   * @param event - The hook event whose payload provides substitution values
   */
  private async runStructuredCommand(templateKey: string, event: HookEvent): Promise<string> {
    const template = COMMAND_TEMPLATES[templateKey]
    if (!template) {
      const msg = `Hook aborted: unknown command template '${templateKey}'`
      console.error(`[HooksEngine] ${msg}`)
      throw new Error(msg)
    }

    // Validate all payload values before they are used as argv elements
    const safeData = sanitizeEventData(event.payload)

    // Build argv — user data goes into array positions, never a shell string
    const args = template.args(safeData)

    console.info(`[HooksEngine] executing: ${template.bin} ${args.join(' ')}`)

    const { stdout, stderr } = await execFileAsync(template.bin, args, { timeout: 30000 })
    return (stdout || stderr).slice(0, 5000)
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
  }
}
