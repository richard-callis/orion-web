/**
 * Catalog of DCO visibility sources (docs/design/dco-visibility.md §7).
 *
 * A source that is not configured writes NO health row, so security-stale-check
 * (which only scans rows) never alerts on it. The sources route turns a catalog
 * entry without a row into `status: 'not_configured'`. From slice 1c, saving a
 * source's settings creates its row (lastSeenAt = now) and disabling deletes it
 * (design §7 (3)-(4)).
 */

/** Global DCO sources → staleAfterMs. */
export const DCO_GLOBAL_SOURCES: Readonly<Record<string, number>> = {
  unifi: 5 * 60_000,
  power_probe: 3 * 60_000,
  bmc: 10 * 60_000,
  flows_edge: 5 * 60_000,
  dns: 10 * 60_000,
  udm_ids: 10 * 60_000,
  udm_fw: 10 * 60_000,
}

/** Per-environment DCO sources → staleAfterMs. */
export const DCO_ENV_SOURCES: Readonly<Record<string, number>> = {
  k8s_inventory: 3 * 60_000,
  longhorn_backups: 3 * 60_000,
  flows_cluster: 5 * 60_000,
  hubble: 5 * 60_000,
}

export interface NotConfiguredSource {
  source: string
  environmentId: string | null
  environmentName: string | null
  staleAfterMs: number
}

/**
 * Catalog entries that have no health row. `globalSeen` holds source names with a
 * SourceHealth row; `envSeen` holds `${environmentId}:${source}` keys with an
 * EnvironmentSourceHealth row. Per-env sources are decided per environment.
 */
export function listNotConfigured(
  globalSeen: ReadonlySet<string>,
  envSeen: ReadonlySet<string>,
  environments: ReadonlyArray<{ id: string; name: string }>,
): NotConfiguredSource[] {
  const out: NotConfiguredSource[] = []
  for (const [source, staleAfterMs] of Object.entries(DCO_GLOBAL_SOURCES)) {
    if (!globalSeen.has(source)) out.push({ source, environmentId: null, environmentName: null, staleAfterMs })
  }
  for (const env of environments) {
    for (const [source, staleAfterMs] of Object.entries(DCO_ENV_SOURCES)) {
      if (!envSeen.has(`${env.id}:${source}`)) {
        out.push({ source, environmentId: env.id, environmentName: env.name, staleAfterMs })
      }
    }
  }
  return out
}
