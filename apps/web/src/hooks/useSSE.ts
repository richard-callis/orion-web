'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { readSSE, parseSSEData, errorMessage } from '@/lib/api'

export interface SSEStreamOptions<T> {
  /** Returns true when an event ends the stream (e.g. `done` / `error`). */
  isTerminal?: (evt: T) => boolean
  /** Called for every parsed event, after it is appended. */
  onEvent?: (evt: T) => void
  /** Turns a thrown error (network, non-2xx) into an event appended to the list. */
  errorEvent?: (message: string) => T
}

/**
 * POST-and-stream helper for endpoints that answer with `text/event-stream`
 * JSON events (bootstrap logs, deploys, …). Collects events, tracks running /
 * done, and aborts the request on unmount or `stop()`.
 */
export function useSSEStream<T>(opts: SSEStreamOptions<T> = {}) {
  const [events, setEvents] = useState<T[]>([])
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const optsRef = useRef(opts)
  optsRef.current = opts

  useEffect(() => () => abortRef.current?.abort(), [])

  const reset = useCallback(() => {
    abortRef.current?.abort()
    setEvents([])
    setDone(false)
    setRunning(false)
  }, [])

  const stop = useCallback(() => abortRef.current?.abort(), [])

  const start = useCallback(async (url: string, init: RequestInit = { method: 'POST' }) => {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setEvents([])
    setDone(false)
    setRunning(true)
    const { isTerminal, onEvent, errorEvent } = optsRef.current
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal })
      if (!res.ok || !res.body) throw new Error(`Request failed: ${res.status}`)
      for await (const raw of readSSE(res.body, ctrl.signal)) {
        const evt = parseSSEData<T>(raw)
        if (evt === null) continue
        setEvents(prev => [...prev, evt])
        onEvent?.(evt)
        if (isTerminal?.(evt)) setDone(true)
      }
    } catch (e) {
      if (ctrl.signal.aborted) return
      if (errorEvent) setEvents(prev => [...prev, errorEvent(errorMessage(e))])
      setDone(true)
    } finally {
      if (abortRef.current === ctrl) setRunning(false)
    }
  }, [])

  return { events, running, done, start, stop, reset }
}

/**
 * Subscribe to a GET EventSource for the lifetime of the component (or until
 * `url` becomes null). The handler is read through a ref, so it may change
 * between renders without reconnecting.
 */
export function useEventSource(
  url: string | null,
  onMessage: (data: string, evt: MessageEvent) => void,
  opts: { event?: string; onError?: (evt: Event) => void } = {},
) {
  const handlerRef = useRef(onMessage)
  handlerRef.current = onMessage
  const errRef = useRef(opts.onError)
  errRef.current = opts.onError
  const event = opts.event

  useEffect(() => {
    if (!url) return
    const es = new EventSource(url)
    const listener = (e: MessageEvent) => handlerRef.current(e.data, e)
    if (event) es.addEventListener(event, listener as EventListener)
    else es.onmessage = listener
    es.onerror = e => errRef.current?.(e) // EventSource reconnects on its own
    return () => {
      if (event) es.removeEventListener(event, listener as EventListener)
      es.close()
    }
  }, [url, event])
}

/**
 * Convenience wrapper: subscribe to a GET SSE endpoint and receive parsed
 * JSON payloads (raw string when the data isn't JSON). Disabled when
 * `enabled` is false or `url` is null.
 */
export function useSSE<T = unknown>(
  url: string | null,
  { onEvent, enabled = true }: { onEvent: (data: T | string) => void; enabled?: boolean },
) {
  useEventSource(enabled ? url : null, raw => {
    let parsed: T | string = raw
    try { parsed = JSON.parse(raw) as T } catch { /* keep raw */ }
    onEvent(parsed)
  })
}
