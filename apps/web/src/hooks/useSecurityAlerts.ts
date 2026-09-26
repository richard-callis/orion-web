'use client'

import useSWR from 'swr'

interface AlertCountResponse {
  pagination?: { total?: number }
}

/** Unacknowledged security alerts in the last hour (shared, visibility-aware poll). */
export function useUnackAlertCount() {
  const { data } = useSWR<AlertCountResponse>(
    '/api/monitoring/security/alerts?acknowledged=false&minutes=60&limit=1',
    { refreshInterval: 30_000 },
  )
  return data?.pagination?.total ?? 0
}
