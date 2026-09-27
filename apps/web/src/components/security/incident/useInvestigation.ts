'use client'

import useSWR from 'swr'
import type { Investigation, Observable } from './types'

type RawInvestigation = Partial<Investigation> & { id: string }

/** Investigation detail (notes + timeline). Notes and Timeline tabs share one request via SWR. */
export function useInvestigation(investigationId: string | null) {
  const { data, isLoading, mutate } = useSWR<{ investigation?: RawInvestigation } | RawInvestigation>(
    investigationId ? `/api/monitoring/security/investigations/${investigationId}` : null,
    { revalidateOnFocus: false },
  )
  const raw = data && ('investigation' in data && data.investigation ? data.investigation : (data as RawInvestigation))
  const investigation: Investigation | null = raw && raw.id
    ? { id: raw.id, observables: raw.observables ?? [], notes: raw.notes ?? [], timeline: raw.timeline ?? [] }
    : null
  return { investigation, loading: isLoading, reload: () => mutate() }
}

export function useObservables(investigationId: string | null) {
  const { data, isLoading, mutate } = useSWR<{ observables?: Observable[] }>(
    investigationId ? `/api/monitoring/security/investigations/${investigationId}/observables` : null,
    { revalidateOnFocus: false },
  )
  return { observables: data?.observables ?? null, loading: isLoading, reload: () => mutate() }
}
