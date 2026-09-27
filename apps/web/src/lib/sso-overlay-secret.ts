import type { JobLogger } from '@/lib/job-runner'
import type { ProviderConfig } from '@/lib/provider-engine'

/**
 * Sync the overlay secret: create or update it with resolved values.
 * Handles opaque __RS_<index>__ tokens left behind by renderProviderConfig()
 * after it rewrites {{ resolveSecret <secret> <key> }} templates. The name/key
 * each token refers to is looked up from pc.resolveSecretRefs (a side-channel
 * map keyed by token) rather than parsed out of the token string — parsing
 * would be ambiguous if a secret key itself contains "__" (Kubernetes secret
 * *names* can't contain "_" per DNS-1123, but keys can, e.g.
 * AUTHENTIK_POSTGRESQL__PASSWORD).
 */
export async function syncOverlaySecret(
  gx: (tool: string, args: Record<string, unknown>) => Promise<string>,
  log: JobLogger,
  overlay: NonNullable<ProviderConfig['overlaySecret']>,
  pc: ProviderConfig,
  ctx: { hostname: string; namespace: string; clusterIssuer: string; adminPassword: string; provider: string },
): Promise<void> {
  // By the time overlay.entries reach here, renderProviderConfig() has already
  // rewritten `{{ resolveSecret <name> <key> }}` into an opaque token like
  // `__RS_0__`. Match that intermediate form; resolve name/key via resolveSecretRefs.
  const placeholderRe = /__RS_\d+__/g
  const refs = pc.resolveSecretRefs ?? {}

  // Step 1: Collect regular entries (with placeholders) and resolve targets
  const stringData: Record<string, string> = {}
  const resolveTargets: Array<{ placeholder: string; secretName: string; secretKey: string }> = []

  for (const entry of overlay.entries) {
    let value = entry.value

    // Resolve {{ adminPassword }}, {{ hostname }}, etc.
    value = value.replace(/\{\{\s*adminPassword\s*\}\}/g, ctx.adminPassword)
    value = value.replace(/\{\{\s*hostname\s*\}\}/g, ctx.hostname)
    value = value.replace(/\{\{\s*clusterIssuer\s*\}\}/g, ctx.clusterIssuer)
    value = value.replace(/\{\{\s*provider\s*\}\}/g, ctx.provider)
    value = value.replace(/\{\{\s*namespace\s*\}\}/g, ctx.namespace)

    // Collect __RS_<index>__ resolve targets (already placeholders at this point,
    // nothing to replace here — just record what needs resolving from the cluster)
    for (const match of value.matchAll(placeholderRe)) {
      const token = match[0]
      const ref = refs[token]
      if (!ref) {
        throw new Error(`Unable to resolve secret placeholder ${token} — no matching entry in resolveSecretRefs`)
      }
      resolveTargets.push({ placeholder: token, secretName: ref.name, secretKey: ref.key })
    }

    stringData[entry.key] = value
  }

  // Step 2: Resolve all placeholders from cluster. Any failure to resolve —
  // lookup error or a missing/empty value — fails loudly instead of silently
  // leaving the literal placeholder token in the applied Secret.
  for (const target of resolveTargets) {
    let data: string | undefined
    try {
      const result = await gx('kubectl_get', {
        resource: 'secret', name: target.secretName, namespace: ctx.namespace, output: 'json',
      })
      data = JSON.parse(result).data?.[target.secretKey]
    } catch (err) {
      throw new Error(
        `Unable to resolve secret placeholder for ${target.secretName}/${target.secretKey} — secret lookup failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      )
    }
    if (!data) {
      throw new Error(
        `Unable to resolve secret placeholder for ${target.secretName}/${target.secretKey} — secret lookup returned no value`
      )
    }
    const resolvedValue = Buffer.from(data, 'base64').toString('utf8')
    // Replace placeholder in all stringData values (exact literal match — the
    // placeholder has no surrounding {{ }} and needs no regex escaping beyond this).
    for (const [key, val] of Object.entries(stringData)) {
      stringData[key] = val.split(target.placeholder).join(resolvedValue)
    }
  }

  // Build the manifest
  const manifestLines: string[] = [
    'apiVersion: v1',
    'kind: Secret',
    'metadata:',
    `  name: ${overlay.name}`,
    `  namespace: ${ctx.namespace}`,
    'type: Opaque',
    'stringData:',
  ]
  for (const [key, value] of Object.entries(stringData)) {
    // Escape double quotes and backslashes in values
    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    manifestLines.push(`  ${key}: "${escaped}"`)
  }

  await gx('kubectl_apply_manifest', { manifest: manifestLines.join('\n') })
}
