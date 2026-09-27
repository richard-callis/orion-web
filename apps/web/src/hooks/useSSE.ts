'use client'
import { useEffect, useRef } from 'react'

export interface UseSSEOptions {
  /** Called with each parsed JSON payload (or the raw string if it isn't JSON). */
  onEvent: (data: unknown) => void
  /** Connect only while true (default true). */
  enabled?: boolean
  /** Delay before reconnecting after an error (default 5s). */
  reconnectMs?: number
}

/**
 * Subscribe to a server-sent-events endpoint with EventSource.
 *
 * - Reconnects after errors (`reconnectMs`), and cleans up on unmount / url change.
 * - `onEvent` may change every render; the latest one is always used without
 *   reconnecting.
 */
export function useSSE(url: string | null, { onEvent, enabled = true, reconnectMs = 5000 }: UseSSEOptions) {
  const handlerRef = useRef(onEvent)
  handlerRef.current = onEvent

  useEffect(() => {
    if (!url || !enabled) return
    let active = true
    let es: EventSource | null = null
    let timer: ReturnType<typeof setTimeout> | null = null

    const connect = () => {
      if (!active) return
      es = new EventSource(url)
      es.addEventListener('message', (evt: MessageEvent<string>) => {
        if (!active) return
        let data: unknown = evt.data
        try { data = JSON.parse(evt.data) } catch { /* non-JSON payload */ }
        handlerRef.current(data)
      })
      es.addEventListener('error', () => {
        es?.close()
        if (active) timer = setTimeout(connect, reconnectMs)
      })
    }

    connect()
    return () => {
      active = false
      if (timer) clearTimeout(timer)
      es?.close()
    }
  }, [url, enabled, reconnectMs])
}
