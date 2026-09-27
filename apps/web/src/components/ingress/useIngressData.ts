'use client'

import useSWR from 'swr'
import { errorMessage } from '@/lib/api'
import type { Domain, Env } from './types'

/**
 * Domains + environments for the ingress page. Local edits are applied to the
 * SWR cache without refetching, so expanded panels and half-filled forms
 * survive; `reload()` revalidates both lists.
 */
export function useIngressData() {
  const domainsQ = useSWR<Domain[]>('/api/ingress/domains', { revalidateOnFocus: false })
  const envsQ = useSWR<Env[]>('/api/environments', { revalidateOnFocus: false })

  const loadError = domainsQ.error ?? envsQ.error
  return {
    domains: domainsQ.data ?? [],
    environments: envsQ.data ?? [],
    loaded: domainsQ.data !== undefined || domainsQ.error !== undefined,
    loading: domainsQ.isValidating || envsQ.isValidating,
    error: loadError ? errorMessage(loadError, 'Failed to fetch') : null,
    reload: () => { void domainsQ.mutate(); void envsQ.mutate() },
    updateDomain: (updated: Domain) =>
      domainsQ.mutate(ds => ds?.map(d => d.id === updated.id ? updated : d), { revalidate: false }),
    addDomain: (created: Domain) =>
      domainsQ.mutate(ds => [...(ds ?? []), created], { revalidate: false }),
  }
}
