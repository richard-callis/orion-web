/**
 * Read-only gateway mode (GATEWAY_READ_ONLY, infra-manager design §5.1).
 *
 * An allowlist: only the tools named here are registered and offered. Anything
 * else, including tools added later and every custom (shell/http) tool pushed by
 * ORION, doesn't exist on such a gateway. Defence in depth: the boundary is the
 * gateway's credentials (RBAC, tokens, sockets).
 *
 * Left out on purpose although they change nothing themselves: docker_inspect (shows
 * every container's environment; comes back with docker-read-proxy), helm_list (reads
 * Secrets), trivy_* (pull images, create scan Jobs), file_read and system_info
 * (host access), knowledge_embed_all (writes ORION's index), and
 * security_propose_action (starts an action).
 */
import type { McpToolConfig } from '../orion-client.js'
import { ArgValidationError } from './validate-args.js'

export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  // Kubernetes
  'kubectl_get', 'kubectl_get_pods', 'kubectl_get_nodes', 'kubectl_get_events', 'kubectl_describe',
  'kubectl_logs', 'kubectl_top_pods', 'kubectl_rollout_status', 'kubectl_wait_nodes_ready', 'storage_stats',
  'dco_k8s_snapshot',
  // Talos
  'talos_get_version', 'talos_get_extensions',
  // Docker
  'docker_ps', 'docker_logs', 'docker_stats',
  // Backups
  'velero_list_backups', 'velero_describe_backup', 'velero_list_schedules',
  // ORION knowledge
  'knowledge_search', 'knowledge_graph', 'knowledge_related', 'knowledge_backlinks', 'find_specialist',
  // Monitoring and security, queries only
  'prometheus_query', 'prometheus_query_range', 'elk_flow_search', 'elk_syslog_search',
  'ntopng_threats', 'ntopng_top_talkers', 'wazuh_alerts', 'wazuh_rootcheck',
  'crowdsec_blocks', 'crowdsec_suggestions',
])

/** Any value but an explicit "off" turns it on: a typo must not make a gateway writable. */
export function isReadOnly(value: string | undefined): boolean {
  return !['', 'false', '0', 'no', 'off'].includes((value ?? '').trim().toLowerCase())
}

/**
 * kubectl get/describe of Secrets, refused in read-only mode: the gateway may read
 * its own join Secret (tokens Orion accepts as this gateway), and on a wider
 * kubeconfig every Secret. Any spelling kubectl accepts: secret, Secrets.v1., a list.
 */
export function refuseSecrets(resource: string): void {
  if (!isReadOnly(process.env.GATEWAY_READ_ONLY)) return
  const kinds = resource.toLowerCase().split(/[,/]/).map(r => r.trim().split('.')[0])
  if (kinds.some(k => k === 'secret' || k === 'secrets')) {
    throw new ArgValidationError('Secrets are not readable through a read-only gateway')
  }
}

export function readOnlyBuiltins<T extends { name: string }>(tools: T[]): T[] {
  return tools.filter(t => READ_ONLY_TOOLS.has(t.name))
}

/**
 * The tools of ORION's policy that may be offered: allowlisted built-ins this
 * gateway registered. A tool claiming to be built-in without being registered
 * would fall through to the custom runner, so it is dropped as well.
 */
export function readOnlyPolicy(tools: McpToolConfig[], registered: Record<string, unknown>): McpToolConfig[] {
  return tools.filter(t => t.builtIn && READ_ONLY_TOOLS.has(t.name) && Object.prototype.hasOwnProperty.call(registered, t.name))
}
