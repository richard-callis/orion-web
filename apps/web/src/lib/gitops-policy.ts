/**
 * GitOps Auto-Merge Policy Engine
 *
 * Classifies a proposed change and returns whether it can be auto-merged
 * or requires human review. Policy is configurable per environment.
 *
 * Default policy matches the ORION architecture plan:
 *   Auto-merge: scale, restart, image patch/minor, configmap, resource limits
 *   Human review: new deployments, ingress, RBAC, network policy, secrets, destructive ops
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type OperationType =
  | 'scale'
  | 'rolling-restart'
  | 'image-update-patch'
  | 'image-update-minor'
  | 'image-update-major'
  | 'configmap-update'
  | 'resource-limits'
  | 'new-deployment'
  | 'new-service'
  | 'ingress-change'
  | 'rbac-change'
  | 'network-policy'
  | 'new-namespace'
  | 'secret-change'
  | 'destructive'
  | 'unknown'

export type MergeDecision = 'auto' | 'review'

export interface PolicyRule {
  operation: OperationType
  decision: MergeDecision
  reason: string
}

export interface PolicyConfig {
  /** Override auto/review for specific operation types */
  overrides?: Partial<Record<OperationType, MergeDecision>>
  /** If true, everything requires review (e.g. prod cluster) */
  reviewAll?: boolean
}

export interface ChangeClassification {
  operation: OperationType
  decision: MergeDecision
  reason: string
  label: string  // Gitea PR label
}

// ── Default policy table ──────────────────────────────────────────────────────

const DEFAULT_POLICY: Record<OperationType, PolicyRule> = {
  'scale': {
    operation: 'scale',
    decision: 'auto',
    reason: 'Scaling replicas up/down is low-risk and fully reversible',
  },
  'rolling-restart': {
    operation: 'rolling-restart',
    decision: 'auto',
    reason: 'Rolling restart causes no downtime on replicated workloads',
  },
  'image-update-patch': {
    operation: 'image-update-patch',
    decision: 'auto',
    reason: 'Patch version bumps (x.y.Z) are considered safe',
  },
  'image-update-minor': {
    operation: 'image-update-minor',
    decision: 'auto',
    reason: 'Minor version bumps (x.Y.z) are generally backwards-compatible',
  },
  'image-update-major': {
    operation: 'image-update-major',
    decision: 'review',
    reason: 'Major version bumps may have breaking changes',
  },
  'configmap-update': {
    operation: 'configmap-update',
    decision: 'auto',
    reason: 'Non-secret ConfigMap updates are low-risk',
  },
  'resource-limits': {
    operation: 'resource-limits',
    decision: 'auto',
    reason: 'Resource limit adjustments are fully reversible',
  },
  'new-deployment': {
    operation: 'new-deployment',
    decision: 'review',
    reason: 'New workloads should be reviewed before going live',
  },
  'new-service': {
    operation: 'new-service',
    decision: 'review',
    reason: 'New services may expose unexpected network paths',
  },
  'ingress-change': {
    operation: 'ingress-change',
    decision: 'review',
    reason: 'Ingress changes affect external traffic routing',
  },
  'rbac-change': {
    operation: 'rbac-change',
    decision: 'review',
    reason: 'RBAC / ClusterRole changes affect security boundaries',
  },
  'network-policy': {
    operation: 'network-policy',
    decision: 'review',
    reason: 'Network policies affect pod-to-pod communication security',
  },
  'new-namespace': {
    operation: 'new-namespace',
    decision: 'review',
    reason: 'New namespaces change cluster structure',
  },
  'secret-change': {
    operation: 'secret-change',
    decision: 'review',
    reason: 'ExternalSecrets / Vault references touch sensitive data paths',
  },
  'destructive': {
    operation: 'destructive',
    decision: 'review',
    reason: 'Destructive operations require explicit human approval',
  },
  'unknown': {
    operation: 'unknown',
    decision: 'review',
    reason: 'Unclassified change — defaulting to human review',
  },
}

// ── Manifest classifier ───────────────────────────────────────────────────────

/**
 * Classify a Kubernetes manifest change by inspecting the YAML diff.
 * `patch` is the new content (or a description of the change from AI).
 */
export function classifyManifest(manifest: string): OperationType {
  const lower = manifest.toLowerCase()

  // Destructive signals
  if (/\bdelete\b|\bdestroy\b|\bremove\b.*\ball\b/i.test(manifest)) return 'destructive'

  // RBAC
  if (/kind:\s*(clusterrole|clusterrolebinding|role|rolebinding)/i.test(manifest)) return 'rbac-change'

  // Network policies
  if (/kind:\s*networkpolicy/i.test(manifest)) return 'network-policy'

  // Namespaces
  if (/kind:\s*namespace/i.test(manifest)) return 'new-namespace'

  // Ingress
  if (/kind:\s*ingress/i.test(manifest)) return 'ingress-change'

  // Secrets / ExternalSecrets
  if (/kind:\s*(externalsecret|secret)/i.test(manifest)) return 'secret-change'

  // New deployment / statefulset (no existing spec)
  if (/kind:\s*(deployment|statefulset|daemonset)/i.test(manifest)) {
    // Heuristic: if it looks like a full manifest (has image: and no "patch" context), treat as new
    if (/^\s*apiversion:/im.test(manifest) && /\bimage:/i.test(manifest)) {
      return 'new-deployment'
    }
  }

  // Service
  if (/kind:\s*service/i.test(manifest) && !/kind:\s*ingress/i.test(manifest)) return 'new-service'

  // ConfigMap (non-secret)
  if (/kind:\s*configmap/i.test(manifest)) return 'configmap-update'

  // Scale signal
  if (/\breplicas:\s*\d/i.test(lower)) return 'scale'

  // Resource limits
  if (/\b(requests|limits):/i.test(manifest) && /\b(cpu|memory):/i.test(manifest)) return 'resource-limits'

  // Image update — try to detect semver bump type
  const imageMatch = manifest.match(/image:\s*\S+:(\d+)\.(\d+)\.(\d+)/i)
  if (imageMatch) return 'image-update-patch' // conservative default for image changes

  return 'unknown'
}

/**
 * Classify an operation from a plain-language description (from AI agent).
 * Useful when the AI knows what it's doing before generating the manifest.
 */
export function classifyOperation(description: string): OperationType {
  const d = description.toLowerCase()

  if (d.includes('scale') || d.includes('replicas')) return 'scale'
  if (d.includes('restart') || d.includes('rollout')) return 'rolling-restart'
  if (d.includes('configmap') && !d.includes('secret')) return 'configmap-update'
  if (d.includes('resource') && (d.includes('limit') || d.includes('request'))) return 'resource-limits'
  if (d.includes('ingress')) return 'ingress-change'
  if (d.includes('rbac') || d.includes('clusterrole') || d.includes('rolebinding')) return 'rbac-change'
  if (d.includes('networkpolicy') || d.includes('network policy')) return 'network-policy'
  if (d.includes('namespace')) return 'new-namespace'
  if (d.includes('secret') || d.includes('externalsecret') || d.includes('vault')) return 'secret-change'
  if (d.includes('delete') || d.includes('destroy') || d.includes('remove all')) return 'destructive'
  if (d.includes('new deployment') || d.includes('deploy ') || d.includes('create deployment')) return 'new-deployment'
  if (d.includes('new service') || d.includes('create service')) return 'new-service'
  if (d.includes('image') || d.includes('tag') || d.includes('upgrade')) {
    if (d.includes('major')) return 'image-update-major'
    if (d.includes('minor')) return 'image-update-minor'
    return 'image-update-patch'
  }

  return 'unknown'
}

// ── Policy evaluator ──────────────────────────────────────────────────────────

export function evaluatePolicy(
  operation: OperationType,
  config?: PolicyConfig,
): ChangeClassification {
  // reviewAll override (strict mode for prod clusters)
  if (config?.reviewAll) {
    return {
      operation,
      decision: 'review',
      reason: 'Environment is in strict review-all mode',
      label: 'needs-review',
    }
  }

  const override = config?.overrides?.[operation]
  const rule = DEFAULT_POLICY[operation]
  const decision = override ?? rule.decision

  return {
    operation,
    decision,
    reason: override
      ? `Environment policy overrides default: ${decision}`
      : rule.reason,
    label: decision === 'auto' ? 'auto-merge' : 'needs-review',
  }
}

/**
 * Full pipeline: classify a manifest/description, apply policy, return decision.
 */
export function classifyAndEvaluate(
  manifestOrDescription: string,
  config?: PolicyConfig,
  mode: 'manifest' | 'description' = 'manifest',
): ChangeClassification {
  const operation = mode === 'manifest'
    ? classifyManifest(manifestOrDescription)
    : classifyOperation(manifestOrDescription)
  return evaluatePolicy(operation, config)
}
