/**
 * HTTP status of a failed Kubernetes API call.
 *
 * @kubernetes/client-node >= 1.0 throws `ApiException` with `.code`. The old
 * 0.x shape (`err.response.statusCode`) never occurs any more — checks written
 * against it (e.g. the 409 conflict retry in dns.ts) silently never matched.
 * The legacy shapes are still accepted so a stray caller can't regress.
 */
export function k8sStatusCode(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined
  const e = err as {
    code?: unknown
    statusCode?: unknown
    response?: { statusCode?: unknown; status?: unknown }
    body?: { code?: unknown }
  }
  for (const v of [e.code, e.statusCode, e.response?.statusCode, e.response?.status, e.body?.code]) {
    if (typeof v === 'number' && v >= 100 && v <= 599) return v
  }
  return undefined
}

export const isK8sConflict = (err: unknown): boolean => k8sStatusCode(err) === 409
export const isK8sNotFound = (err: unknown): boolean => k8sStatusCode(err) === 404
