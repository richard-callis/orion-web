'use client'

import { useState, useEffect } from 'react'

export function useUnackAlertCount() {
  const [count, setCount] = useState(0)

  useEffect(() => {
    fetch('/api/monitoring/security/alerts?acknowledged=false&minutes=60&limit=1')
      .then(r => r.json())
      .then(d => { setCount(d.pagination?.total ?? 0) })
      .catch(() => {})
  }, [])

  return count
}
