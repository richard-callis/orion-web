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
