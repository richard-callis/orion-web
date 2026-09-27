'use client'
import useSWR from 'swr'

export interface AgentOption { id: string; name: string }

const EMPTY: AgentOption[] = []

/** Agents the current user can see (GET /api/agents), shared/deduped via SWR. */
export function useAgents() {
  const { data, error, isLoading } = useSWR<AgentOption[] | { agents?: AgentOption[] }>('/api/agents', { revalidateOnFocus: false })
  const agents = Array.isArray(data) ? data : (data?.agents ?? EMPTY)
  return { agents, error, isLoading }
}
