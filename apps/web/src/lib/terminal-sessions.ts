/**
 * Terminal Session Manager
 *
 * Each session is a persistent bash process running inside a real PTY via node-pty.
 * A proper PTY means SSH, vim, htop, etc. all work correctly.
 * Output is buffered for reconnecting SSE subscribers.
 * Sessions time out after 30 minutes of inactivity.
 */

import * as pty from 'node-pty'
import { randomBytes } from 'crypto'

interface Session {
  pty:          ReturnType<typeof pty.spawn>
  subscribers:  Map<string, (data: string) => void>
  scrollback:   string[]       // recent raw output chunks, capped at MAX_SCROLLBACK
  createdAt:    number
  lastActivity: number
  alive:        boolean
}

const MAX_SCROLLBACK  = 300
const SESSION_TIMEOUT = 30 * 60 * 1_000   // 30 min idle

// Singleton via globalThis so all Next.js route bundles share the same Map
declare global {
  // eslint-disable-next-line no-var
  var __terminalSessions: Map<string, Session> | undefined
  // eslint-disable-next-line no-var
  var __terminalReaperStarted: boolean | undefined
}

const sessions: Map<string, Session> = (globalThis.__terminalSessions ??= new Map())

if (!globalThis.__terminalReaperStarted) {
  globalThis.__terminalReaperStarted = true
  setInterval(() => {
    const now = Date.now()
    for (const [id, s] of sessions) {
      if (now - s.lastActivity > SESSION_TIMEOUT || !s.alive) {
        try { s.pty.kill() } catch { /* already dead */ }
        sessions.delete(id)
      }
    }
  }, 60_000).unref()
}

export function createSession(): string {
  const id   = randomBytes(16).toString('hex')
  const proc = pty.spawn('bash', ['--norc', '--noprofile'], {
    name: 'xterm-256color',
    cols: 220,
    rows: 50,
    env: {
      ...process.env,
      TERM:         'xterm-256color',
      COLORTERM:    'truecolor',
      PS1:          '\\[\\033[0;32m\\]\\u@orion\\[\\033[0m\\]:\\[\\033[0;34m\\]\\w\\[\\033[0m\\]\\$ ',
      PS2:          '> ',
      HISTCONTROL:  'ignoredups',
    } as Record<string, string>,
  })

  const session: Session = {
    pty:          proc,
    subscribers:  new Map(),
    scrollback:   [],
    createdAt:    Date.now(),
    lastActivity: Date.now(),
    alive:        true,
  }

  const emit = (chunk: string) => {
    session.lastActivity = Date.now()
    session.scrollback.push(chunk)
    if (session.scrollback.length > MAX_SCROLLBACK) session.scrollback.shift()
    for (const cb of session.subscribers.values()) cb(chunk)
  }

  proc.onData((data: string) => emit(data))
  proc.onExit(({ exitCode }) => {
    session.alive = false
    emit(`\r\n\x1b[90m[process exited: ${exitCode ?? '?'}]\x1b[0m\r\n`)
  })

  sessions.set(id, session)
  return id
}

export function sessionExists(id: string): boolean {
  return sessions.has(id)
}

export function writeToSession(id: string, data: string): boolean {
  const s = sessions.get(id)
  if (!s?.alive) return false
  s.lastActivity = Date.now()
  try {
    s.pty.write(data)
    return true
  } catch {
    return false
  }
}

export function resizeSession(id: string, cols: number, rows: number): void {
  const s = sessions.get(id)
  if (s?.alive) {
    try { s.pty.resize(cols, rows) } catch { /* ignore */ }
  }
}

/** Subscribe to output; returns scrollback chunks to replay, or null if session not found. */
export function subscribeToSession(
  id: string,
  subscriberId: string,
  cb: (data: string) => void,
): string[] | null {
  const s = sessions.get(id)
  if (!s) return null
  s.subscribers.set(subscriberId, cb)
  return [...s.scrollback]
}

export function unsubscribeFromSession(id: string, subscriberId: string): void {
  sessions.get(id)?.subscribers.delete(subscriberId)
}

export function listSessions(): Array<{ id: string; createdAt: number; lastActivity: number; alive: boolean }> {
  return Array.from(sessions.entries()).map(([id, s]) => ({
    id,
    createdAt:    s.createdAt,
    lastActivity: s.lastActivity,
    alive:        s.alive,
  }))
}

export function killSession(id: string): void {
  const s = sessions.get(id)
  if (s) {
    try { s.pty.kill() } catch { /* ignore */ }
    sessions.delete(id)
  }
}
