'use client'

import { useState, useEffect } from 'react'

export function useUnackAlertCount() {
  const [count, setCount] = useState(0)

  useEffect(() => {
    const fetch_ = () =>
      fetch('/api/monitoring/security/alerts?acknowledged=false&minutes=60&limit=1')
        .then(r => r.json())
        .then(d => { setCount(d.pagination?.total ?? 0) })
        .catch(() => {})

    fetch_()
    const timer = setInterval(fetch_, 30_000)
    return () => clearInterval(timer)
  }, [])

  return count
}
