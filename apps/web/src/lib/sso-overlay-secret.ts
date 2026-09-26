import type { JobLogger } from '@/lib/job-runner'
import type { ProviderConfig } from '@/lib/provider-engine'

/**
 * Sync the overlay secret: create or update it with resolved values.
 * Handles __RS_<secret>_<key>__ placeholders left behind by renderProviderConfig()
 * after it rewrites {{ resolveSecret <secret> <key> }} templates.
 */
export async function syncOverlaySecret(
  gx: (tool: string, args: Record<string, unknown>) => Promise<string>,
  log: JobLogger,
  overlay: NonNullable<ProviderConfig['overlaySecret']>,
  pc: ProviderConfig,
  ctx: { hostname: string; namespace: string; clusterIssuer: string; adminPassword: string; provider: string },
): Promise<void> {
  // By the time overlay.entries reach here, renderProviderConfig() has already
  // rewritten `{{ resolveSecret <name> <key> }}` into the bare intermediate token
  // `__RS_<name>_<key>__` (no surrounding `{{ }}`). Match that intermediate form.
  const placeholderRe = /__RS_(.+?)_(.+?)__/g

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

    // Collect __RS_<name>_<key>__ resolve targets (already placeholders at this point,
    // nothing to replace here — just record what needs resolving from the cluster)
    for (const match of value.matchAll(placeholderRe)) {
      const [ph, secretName, secretKey] = match
      resolveTargets.push({ placeholder: ph, secretName, secretKey })
    }

    stringData[entry.key] = value
  }

  // Step 2: Resolve all placeholders from cluster
  for (const target of resolveTargets) {
    try {
      const result = await gx('kubectl_get', {
        resource: 'secret', name: target.secretName, namespace: ctx.namespace, output: 'json',
      })
      const data = JSON.parse(result).data?.[target.secretKey]
      if (data) {
        const resolvedValue = Buffer.from(data, 'base64').toString('utf8')
        // Replace placeholder in all stringData values (exact literal match — the
        // placeholder has no surrounding {{ }} and needs no regex escaping beyond this).
        for (const [key, val] of Object.entries(stringData)) {
          stringData[key] = val.split(target.placeholder).join(resolvedValue)
        }
      }
    } catch {
      log(`  WARNING: Could not resolve secret ${target.secretName}.${target.secretKey}`)
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
