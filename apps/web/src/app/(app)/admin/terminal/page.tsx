'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Terminal, Wifi, WifiOff, Plus, X, Copy, ChevronRight } from 'lucide-react'

// ── ANSI parser ───────────────────────────────────────────────────────────────

interface Span {
  text:      string
  fg?:       string
  bg?:       string
  bold?:     boolean
  dim?:      boolean
  italic?:   boolean
  underline?: boolean
}

const FG: Record<number, string> = {
  30: '#3d3d3d', 31: '#ff5555', 32: '#50fa7b', 33: '#f1fa8c',
  34: '#6272a4', 35: '#ff79c6', 36: '#8be9fd', 37: '#f8f8f2',
  90: '#6272a4', 91: '#ff6e6e', 92: '#69ff94', 93: '#ffffa5',
  94: '#d6acff', 95: '#ff92df', 96: '#a4ffff', 97: '#ffffff',
}
const BG: Record<number, string> = {
  40: '#21222c', 41: '#ff5555', 42: '#50fa7b', 43: '#f1fa8c',
  44: '#6272a4', 45: '#ff79c6', 46: '#8be9fd', 47: '#f8f8f2',
}

interface ParseState {
  fg?:       string
  bg?:       string
  bold?:     boolean
  dim?:      boolean
  italic?:   boolean
  underline?: boolean
}

function applySGR(codes: number[], state: ParseState): ParseState {
  const s = { ...state }
  let i = 0
  while (i < codes.length) {
    const c = codes[i]
    if (c === 0) {
      Object.assign(s, { fg: undefined, bg: undefined, bold: false, dim: false, italic: false, underline: false })
    } else if (c === 1)  s.bold      = true
    else if (c === 2)    s.dim       = true
    else if (c === 3)    s.italic    = true
    else if (c === 4)    s.underline = true
    else if (c === 22)   s.bold      = false
    else if (c === 23)   s.italic    = false
    else if (c === 24)   s.underline = false
    else if (FG[c])      s.fg        = FG[c]
    else if (c === 39)   s.fg        = undefined
    else if (BG[c])      s.bg        = BG[c]
    else if (c === 49)   s.bg        = undefined
    else if (c === 38 && codes[i + 1] === 5) {
      // 256-color foreground
      const idx = codes[i + 2] ?? 0
      s.fg = `var(--c${idx}, #888)`; i += 2
    } else if (c === 48 && codes[i + 1] === 5) {
      const idx = codes[i + 2] ?? 0
      s.bg = `var(--c${idx}, #222)`; i += 2
    } else if (c === 38 && codes[i + 1] === 2) {
      const r = codes[i + 2] ?? 0, g = codes[i + 3] ?? 0, b = codes[i + 4] ?? 0
      s.fg = `rgb(${r},${g},${b})`; i += 4
    } else if (c === 48 && codes[i + 1] === 2) {
      const r = codes[i + 2] ?? 0, g = codes[i + 3] ?? 0, b = codes[i + 4] ?? 0
      s.bg = `rgb(${r},${g},${b})`; i += 4
    }
    i++
  }
  return s
}

// Parse raw terminal bytes into an array of lines (each line = array of spans)
function parseOutput(raw: string): { lines: Span[][] } {
  // We'll return new lines to append; caller manages existing lines
  const result: Span[][] = [[]]
  let state: ParseState = {}
  let i = 0

  const currentLine = () => result[result.length - 1]
  const pushText = (text: string) => {
    if (!text) return
    const line = currentLine()
    const last = line[line.length - 1]
    // Merge consecutive spans with identical style
    if (last && last.fg === state.fg && last.bg === state.bg &&
        last.bold === state.bold && last.dim === state.dim &&
        last.italic === state.italic && last.underline === state.underline) {
      last.text += text
    } else {
      line.push({ text, ...state })
    }
  }

  while (i < raw.length) {
    const ch = raw[i]

    // ESC sequence
    if (ch === '\x1b') {
      const next = raw[i + 1]

      if (next === '[') {
        // CSI sequence — find terminator
        let j = i + 2
        while (j < raw.length && !String.fromCharCode(raw.charCodeAt(j)).match(/[A-Za-z]/)) j++
        const terminator = raw[j]
        const params     = raw.slice(i + 2, j)

        if (terminator === 'm') {
          // SGR
          const codes = params === '' ? [0] : params.split(';').map(Number)
          state = applySGR(codes, state)
        } else if (terminator === 'J') {
          // Erase display
          if (params === '' || params === '2') {
            result.length = 0
            result.push([])
          }
        } else if (terminator === 'H' || terminator === 'f') {
          // Cursor position — treat as newline if at home (0;0)
        } else if (terminator === 'K') {
          // Erase line — remove last span text to end (simplification)
        }
        // Skip all other CSI (cursor movement etc.)
        i = j + 1
        continue
      } else if (next === ']') {
        // OSC — skip until BEL or ST
        let j = i + 2
        while (j < raw.length && raw[j] !== '\x07' && !(raw[j] === '\x1b' && raw[j + 1] === '\\')) j++
        i = j + (raw[j] === '\x07' ? 1 : 2)
        continue
      } else {
        // Unknown escape — skip 2 chars
        i += 2
        continue
      }
    }

    if (ch === '\r') {
      // Carriage return: move to start of line (overwrite mode)
      // Simplification: just ignore bare CR, only act on \r\n
      if (raw[i + 1] === '\n') {
        result.push([])
        i += 2
      } else {
        // Overwrite current line from start
        result[result.length - 1] = []
        i++
      }
      continue
    }

    if (ch === '\n') {
      result.push([])
      i++
      continue
    }

    if (ch === '\x07') { i++; continue } // BEL
    if (ch === '\x08') {
      // Backspace — remove last char of last span
      const line = currentLine()
      if (line.length > 0) {
        const last = line[line.length - 1]
        if (last.text.length > 1) last.text = last.text.slice(0, -1)
        else line.pop()
      }
      i++; continue
    }

    pushText(ch)
    i++
  }

  return { lines: result }
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface TabSession {
  id:         string
  sessionId:  string | null
  connected:  boolean
  error:      string | null
  lines:      Span[][]
  history:    string[]
  histIndex:  number
  input:      string
  title:      string
}

function emptyTab(id: string, title: string): TabSession {
  return { id, sessionId: null, connected: false, error: null, lines: [], history: [], histIndex: -1, input: '', title }
}

// ── Terminal page ─────────────────────────────────────────────────────────────

export default function TerminalPage() {
  const [tabs, setTabs]         = useState<TabSession[]>([emptyTab('t1', 'bash')])
  const [activeTab, setActiveTab] = useState('t1')
  const tabCounter              = useRef(1)
  const outputRefs              = useRef<Map<string, HTMLDivElement>>(new Map())
  const inputRefs               = useRef<Map<string, HTMLInputElement>>(new Map())
  const esRefs                  = useRef<Map<string, EventSource>>(new Map())

  const tab = useMemo(() => tabs.find(t => t.id === activeTab) ?? tabs[0], [tabs, activeTab])

  // ── Session lifecycle ──────────────────────────────────────────────────────

  const initSession = useCallback(async (tabId: string) => {
    try {
      setTabs(ts => ts.map(t => t.id === tabId ? { ...t, error: null } : t))

      const res = await fetch('/api/admin/terminal/session', { method: 'POST' })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(`Session create failed: ${res.status} ${text.slice(0, 120)}`)
      }
      const { sessionId } = await res.json() as { sessionId: string }
      if (!sessionId) throw new Error('No sessionId returned from server')

      setTabs(ts => ts.map(t => t.id === tabId ? { ...t, sessionId, connected: false } : t))

      // Connect SSE
      const es = new EventSource(`/api/admin/terminal/${sessionId}/stream`)
      esRefs.current.set(tabId, es)

      es.onopen = () => {
        setTabs(ts => ts.map(t => t.id === tabId ? { ...t, connected: true, error: null } : t))
      }

      es.onmessage = (e) => {
        const raw = atob(e.data)
        const { lines: newLines } = parseOutput(raw)

        setTabs(ts => ts.map(t => {
          if (t.id !== tabId) return t
          const updated = [...t.lines]
          if (updated.length === 0) updated.push([])

          for (let i = 0; i < newLines.length; i++) {
            if (i === 0) {
              updated[updated.length - 1] = [...updated[updated.length - 1], ...newLines[0]]
            } else {
              updated.push([...newLines[i]])
            }
          }
          const MAX_LINES = 2000
          return { ...t, lines: updated.length > MAX_LINES ? updated.slice(-MAX_LINES) : updated }
        }))

        requestAnimationFrame(() => {
          const div = outputRefs.current.get(tabId)
          if (div) div.scrollTop = div.scrollHeight
        })
      }

      es.onerror = (ev) => {
        console.error('[terminal] SSE error', ev)
        setTabs(ts => ts.map(t => t.id === tabId
          ? { ...t, connected: false, error: `SSE error (readyState=${es.readyState})` }
          : t))
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[terminal] initSession error', msg)
      setTabs(ts => ts.map(t => t.id === tabId ? { ...t, connected: false, error: msg } : t))
    }
  }, [])

  // Init first tab on mount
  useEffect(() => {
    initSession('t1')
    return () => {
      for (const es of esRefs.current.values()) es.close()
    }
  }, [initSession])

  // Focus input when tab changes
  useEffect(() => {
    requestAnimationFrame(() => {
      inputRefs.current.get(activeTab)?.focus()
    })
  }, [activeTab])

  // ── Input handling ─────────────────────────────────────────────────────────

  const sendInput = useCallback((tabId: string, sessionId: string, data: string) => {
    fetch(`/api/admin/terminal/${sessionId}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data }),
    }).catch(() => {})
  }, [])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>, t: TabSession) => {
    if (!t.sessionId) return

    if (e.key === 'Enter') {
      const cmd = t.input
      sendInput(t.id, t.sessionId, cmd + '\n')
      setTabs(ts => ts.map(x => x.id === t.id
        ? { ...x, input: '', history: cmd ? [cmd, ...x.history.slice(0, 99)] : x.history, histIndex: -1 }
        : x))

    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setTabs(ts => ts.map(x => {
        if (x.id !== t.id) return x
        const idx = Math.min(x.histIndex + 1, x.history.length - 1)
        return { ...x, histIndex: idx, input: x.history[idx] ?? '' }
      }))

    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setTabs(ts => ts.map(x => {
        if (x.id !== t.id) return x
        const idx = Math.max(x.histIndex - 1, -1)
        return { ...x, histIndex: idx, input: idx >= 0 ? (x.history[idx] ?? '') : '' }
      }))

    } else if (e.ctrlKey && e.key === 'c') {
      e.preventDefault()
      sendInput(t.id, t.sessionId, '\x03')
      setTabs(ts => ts.map(x => x.id === t.id ? { ...x, input: '' } : x))

    } else if (e.ctrlKey && e.key === 'd') {
      e.preventDefault()
      sendInput(t.id, t.sessionId, '\x04')

    } else if (e.ctrlKey && e.key === 'l') {
      e.preventDefault()
      setTabs(ts => ts.map(x => x.id === t.id ? { ...x, lines: [] } : x))

    } else if (e.ctrlKey && e.key === 'u') {
      e.preventDefault()
      setTabs(ts => ts.map(x => x.id === t.id ? { ...x, input: '' } : x))
    }
  }, [sendInput])

  // ── Tab management ─────────────────────────────────────────────────────────

  const addTab = async () => {
    tabCounter.current++
    const id    = `t${tabCounter.current}`
    const title = 'bash'
    setTabs(ts => [...ts, emptyTab(id, title)])
    setActiveTab(id)
    await initSession(id)
  }

  const closeTab = async (tabId: string) => {
    const t = tabs.find(x => x.id === tabId)
    if (t?.sessionId) {
      fetch('/api/admin/terminal/session', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: t.sessionId }),
      }).catch(() => {})
    }
    esRefs.current.get(tabId)?.close()
    esRefs.current.delete(tabId)

    setTabs(ts => {
      const next = ts.filter(x => x.id !== tabId)
      if (activeTab === tabId && next.length > 0) {
        setActiveTab(next[next.length - 1].id)
      }
      return next
    })
  }

  const copyOutput = () => {
    const text = tab.lines.map(line => line.map(s => s.text).join('')).join('\n')
    navigator.clipboard.writeText(text).catch(() => {})
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="absolute inset-0 flex flex-col bg-[#0d0d0d] overflow-hidden">

      {/* ── Top bar ── */}
      <div className="flex items-center gap-0 border-b border-[#1e1e1e] bg-[#111] flex-shrink-0 select-none">

        {/* Tabs */}
        <div className="flex items-end h-9 flex-1 min-w-0 overflow-x-auto scrollbar-none">
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`
                group flex items-center gap-2 h-full px-4 text-xs border-r border-[#1e1e1e]
                transition-colors flex-shrink-0 relative
                ${t.id === activeTab
                  ? 'bg-[#0d0d0d] text-[#50fa7b] border-b-0'
                  : 'text-[#6272a4] hover:text-[#f8f8f2] hover:bg-[#161616]'}
              `}
            >
              <Terminal size={11} className="flex-shrink-0" />
              <span className="font-mono">{t.title}</span>

              {/* Status dot */}
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                t.connected ? 'bg-[#50fa7b]' : 'bg-[#ff5555]'
              }`} />

              {tabs.length > 1 && (
                <span
                  onClick={e => { e.stopPropagation(); closeTab(t.id) }}
                  className="opacity-0 group-hover:opacity-100 transition-opacity hover:text-[#ff5555] ml-0.5 cursor-pointer"
                >
                  <X size={11} />
                </span>
              )}
            </button>
          ))}

          <button
            onClick={addTab}
            className="flex items-center justify-center w-8 h-full text-[#6272a4] hover:text-[#f8f8f2] hover:bg-[#161616] transition-colors flex-shrink-0"
            title="New terminal"
          >
            <Plus size={13} />
          </button>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 px-3 border-l border-[#1e1e1e]">
          <button
            onClick={copyOutput}
            title="Copy output"
            className="p-1.5 text-[#6272a4] hover:text-[#f8f8f2] transition-colors rounded"
          >
            <Copy size={13} />
          </button>
          <div className="flex items-center gap-1.5 ml-1 text-[10px] font-mono">
            {tab.connected
              ? <><Wifi size={11} className="text-[#50fa7b]" /><span className="text-[#50fa7b]">connected</span></>
              : <>
                  <WifiOff size={11} className="text-[#ff5555]" />
                  <span className="text-[#ff5555]" title={tab.error ?? undefined}>
                    {tab.error ? tab.error.slice(0, 60) : 'disconnected'}
                  </span>
                  <button
                    onClick={() => initSession(tab.id)}
                    className="ml-1 px-1.5 py-0.5 rounded text-[#6272a4] hover:text-[#f8f8f2] border border-[#333] hover:border-[#50fa7b] transition-colors"
                  >reconnect</button>
                </>
            }
          </div>
        </div>
      </div>

      {/* ── Terminal body ── */}
      <div className="flex-1 flex flex-col min-h-0 relative">

        {/* Output viewport */}
        <div
          ref={el => { if (el) outputRefs.current.set(tab.id, el) }}
          onClick={() => inputRefs.current.get(tab.id)?.focus()}
          className="flex-1 overflow-y-auto px-4 pt-3 pb-1 font-mono text-[13px] leading-[1.6] cursor-text"
          style={{ fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', monospace" }}
        >
          {tab.lines.map((line, li) => (
            <div key={li} className="whitespace-pre-wrap break-all min-h-[1.6em]">
              {line.length === 0
                ? <>&nbsp;</>
                : line.map((span, si) => (
                    <span
                      key={si}
                      style={{
                        color:           span.fg ?? '#cdd6f4',
                        backgroundColor: span.bg,
                        fontWeight:      span.bold ? 700 : undefined,
                        opacity:         span.dim ? 0.6 : undefined,
                        fontStyle:       span.italic ? 'italic' : undefined,
                        textDecoration:  span.underline ? 'underline' : undefined,
                      }}
                    >
                      {span.text}
                    </span>
                  ))
              }
            </div>
          ))}
        </div>

        {/* ── Input bar ── */}
        <div className="flex-shrink-0 flex items-center gap-0 border-t border-[#1a1a1a] bg-[#0d0d0d] px-3 py-2">
          <ChevronRight size={14} className="text-[#50fa7b] flex-shrink-0 mr-1" />
          <input
            ref={el => { if (el) inputRefs.current.set(tab.id, el) }}
            key={tab.id}
            value={tab.input}
            onChange={e => setTabs(ts => ts.map(t => t.id === tab.id ? { ...t, input: e.target.value } : t))}
            onKeyDown={e => handleKeyDown(e, tab)}
            disabled={!tab.connected}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            placeholder={tab.connected ? '' : 'connecting…'}
            className={`
              flex-1 bg-transparent outline-none font-mono text-[13px] caret-[#50fa7b]
              placeholder:text-[#44475a] min-w-0
              ${tab.connected ? 'text-[#f8f8f2]' : 'text-[#6272a4]'}
            `}
            style={{ fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', monospace" }}
          />
        </div>
      </div>

      {/* ── Keyboard shortcuts legend ── */}
      <div className="flex-shrink-0 flex items-center gap-5 px-4 py-1.5 border-t border-[#1a1a1a] bg-[#0a0a0a]">
        {[
          ['↑↓',    'history'],
          ['Ctrl+C', 'interrupt'],
          ['Ctrl+L', 'clear'],
          ['Ctrl+U', 'clear line'],
          ['Ctrl+D', 'EOF'],
        ].map(([key, label]) => (
          <span key={key} className="flex items-center gap-1.5 text-[10px] text-[#44475a]">
            <kbd className="px-1.5 py-0.5 rounded bg-[#1a1a1a] text-[#6272a4] font-mono border border-[#2a2a2a] text-[10px]">
              {key}
            </kbd>
            {label}
          </span>
        ))}
        <span className="ml-auto text-[10px] text-[#44475a] font-mono">
          {tab.lines.length} lines
        </span>
      </div>
    </div>
  )
}
