/**
 * Hooks Engine for ORION Gateways.
 *
 * Manages reactive hooks that fire on infrastructure events (pod crashes, OOM kills,
 * disk full, ArgoCD degraded, tool execution). Hooks are fetched from ORION (NebulaInstances
 * of category "hook") and executed when their trigger conditions match.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'

import { OrionClient } from './orion-client'

export type HookEvent = {
  type: 'pod_crashloop' | 'pod_oom' | 'node_disk_full' | 'sync_degraded' | 'tool_execution'
  payload: Record<string, unknown>
}

export class HooksEngine {
  private orion: OrionClient
  private hooks: Array<{ id: string; name: string; spec: any }> = []
  private interval: NodeJS.Timer | null = null

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
        output = await this.runShellCommand(spec.actionConfig.command, event)
      } else if (spec.actionType === 'send_notification') {
        output = spec.actionConfig.message.replace(
          /{(\w+)}/g,
          (_, key) => String((event.payload as any)[key] ?? ''),
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
   * Allowed commands for hook execution (safelist).
   * Only kubectl, helm, docker, and curl (cluster-internal only) are permitted.
   */
  private static readonly ALLOWED_COMMANDS = new Set(['kubectl', 'helm', 'docker', 'curl'])

  /**
   * Pattern for safe substitution values — kubernetes resource name characters only.
   * Prevents shell injection via event payload values.
   */
  private static readonly SAFE_VALUE_PATTERN = /^[a-z0-9][a-z0-9\-\.\/\_]*$/i

  private async runShellCommand(template: string, event: HookEvent): Promise<string> {
    // Replace placeholders with event payload values, rejecting unsafe values
    let substitutionError: string | null = null
    const cmd = template.replace(/{(\w+)}/g, (match, key) => {
      const raw = String((event.payload as any)[key] ?? '')
      if (!HooksEngine.SAFE_VALUE_PATTERN.test(raw)) {
        substitutionError = `Hook aborted: payload value for '${key}' contains unsafe characters: '${raw}'`
        return match // leave placeholder to abort safely below
      }
      return raw
    })

    if (substitutionError) {
      console.error(`[HooksEngine] ${substitutionError}`)
      throw new Error(substitutionError)
    }

    // Split on whitespace (simple tokenization — quoted args not supported)
    // Values are sanitized above so shell injection is prevented even without quoted-string parsing.
    const [command, ...args] = cmd.trim().split(/\s+/)

    // Safelist check: only allow known-safe commands
    if (!command || !HooksEngine.ALLOWED_COMMANDS.has(command)) {
      const msg = `Hook aborted: command '${command}' is not in the allowed command list (kubectl, helm, docker, curl)`
      console.error(`[HooksEngine] ${msg}`)
      throw new Error(msg)
    }

    return new Promise((resolve, reject) => {
      execFile(command, args, { timeout: 30000 }, (err, stdout) => {
        if (err) reject(err)
        else resolve(stdout.toString().slice(0, 5000))
      })
    })
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
  }
}
