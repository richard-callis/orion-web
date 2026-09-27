'use client'

import { useState } from 'react'
import useSWR from 'swr'

export interface ClusterEnvironment {
  id: string
  name: string
  type: string
  status?: string
  gatewayUrl: string | null
}

/**
 * Cluster environments that have a gateway, plus the selected one. With a
 * single cluster it is selected automatically.
 */
export function useClusterEnvironments() {
  const { data, isLoading } = useSWR<ClusterEnvironment[]>('/api/environments', { revalidateOnFocus: false })
  const environments = (data ?? []).filter(e => e.type === 'cluster' && e.gatewayUrl)
  const [picked, setEnvId] = useState('')
  const envId = picked || (environments.length === 1 ? environments[0].id : '')
  return { environments, envId, setEnvId, loading: isLoading }
}
