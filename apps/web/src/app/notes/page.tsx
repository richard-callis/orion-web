'use client'
import { useState, useEffect, useRef, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkEmoji from 'remark-emoji'
import rehypeHighlight from 'rehype-highlight'
import 'highlight.js/styles/atom-one-dark.css'
import { CodeBlock } from '@/components/notes/CodeBlock'
import {
  Plus, Search, ChevronRight, ChevronDown, Trash2, FileText,
  Pin, Pencil, Eye, ArrowLeft,
} from 'lucide-react'

// Remark plugin: transforms > [!NOTE] / [!WARNING] etc. blockquotes into
// callout nodes by stripping the prefix and tagging with data-callout.
function remarkCallouts() {
  return (tree: { children: unknown[] }) => {
    function walk(nodes: unknown[]) {
      for (const node of nodes) {
        const n = node as { type: string; children?: unknown[]; data?: Record<string, unknown> }
        if (n.type === 'blockquote' && n.children?.length) {
          const firstPara = n.children[0] as { type: string; children?: Array<{ type: string; value?: string }> }
          if (firstPara?.type === 'paragraph' && firstPara.children?.length) {
            const firstText = firstPara.children[0]
            const match = /^\[!(NOTE|TIP|WARNING|IMPORTANT|DANGER|CAUTION)\]\s*/i.exec(firstText?.value ?? '')
            if (match) {
              firstText.value = (firstText.value ?? '').slice(match[0].length)
              n.data = {
                ...(n.data ?? {}),
                hProperties: { 'data-callout': match[1].toUpperCase() },
              }
            }
          }
        }
        if (n.children) walk(n.children as unknown[])
      }
    }
    walk(tree.children)
  }
}

const CALLOUT_STYLES: Record<string, { border: string; bg: string; label: string; icon: string }> = {
  NOTE:      { border: 'border-blue-500/50',   bg: 'bg-blue-500/10',   label: 'text-blue-400',   icon: 'ℹ️' },
  TIP:       { border: 'border-green-500/50',  bg: 'bg-green-500/10',  label: 'text-green-400',  icon: '💡' },
  WARNING:   { border: 'border-yellow-500/50', bg: 'bg-yellow-500/10', label: 'text-yellow-400', icon: '⚠️' },
  IMPORTANT: { border: 'border-purple-500/50', bg: 'bg-purple-500/10', label: 'text-purple-400', icon: '📌' },
  DANGER:    { border: 'border-red-500/50',    bg: 'bg-red-500/10',    label: 'text-red-400',    icon: '🔥' },
  CAUTION:   { border: 'border-orange-500/50', bg: 'bg-orange-500/10', label: 'text-orange-400', icon: '⚡' },
}

interface Note {
  id: string
  title: string
  content: string
  folder: string
  pinned: boolean
  createdAt: string
  updatedAt: string
}

export default function NotesPage() {
  const [notes, setNotes] = useState<Note[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const [localTitle, setLocalTitle] = useState('')
  const [localContent, setLocalContent] = useState('')
  const [localFolder, setLocalFolder] = useState('General')
  const [search, setSearch] = useState('')
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set())
  const [mobileView, setMobileView] = useState<'list' | 'editor'>('list')
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const isSavingRef = useRef(false)

  // Fetch notes on mount
  useEffect(() => {
    fetch('/api/notes')
      .then(r => r.json())
      .then(setNotes)
      .catch(console.error)
  }, [])

  const selectedNote = notes.find(n => n.id === selectedId) ?? null

  // Sync local state when selection changes
  useEffect(() => {
    if (selectedNote) {
      setLocalTitle(selectedNote.title)
      setLocalContent(selectedNote.content)
      setLocalFolder(selectedNote.folder)
    }
  }, [selectedId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced save
  const scheduleSave = useCallback((id: string, title: string, content: string, folder: string) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(async () => {
      if (isSavingRef.current) return
      isSavingRef.current = true
      try {
        const res = await fetch(`/api/notes/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, content, folder }),
        })
        if (res.ok) {
          const updated: Note = await res.json()
          setNotes(prev => prev.map(n => n.id === id ? updated : n))
        }
      } finally {
        isSavingRef.current = false
      }
    }, 800)
  }, [])

  const handleTitleChange = (v: string) => {
    setLocalTitle(v)
    if (selectedId) scheduleSave(selectedId, v, localContent, localFolder)
  }

  const handleContentChange = (v: string) => {
    setLocalContent(v)
    if (selectedId) scheduleSave(selectedId, localTitle, v, localFolder)
  }

  const handleFolderChange = (v: string) => {
    setLocalFolder(v)
    if (selectedId) scheduleSave(selectedId, localTitle, localContent, v)
  }

  const handlePinToggle = async () => {
    if (!selectedNote) return
    const newPinned = !selectedNote.pinned
    const res = await fetch(`/api/notes/${selectedNote.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned: newPinned }),
    })
    if (res.ok) {
      const updated: Note = await res.json()
      setNotes(prev => {
        const mapped = prev.map(n => n.id === updated.id ? updated : n)
        return [...mapped].sort((a, b) => {
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
          return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        })
      })
    }
  }

  const createNote = async () => {
    const res = await fetch('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Untitled Note', content: '', folder: 'General' }),
    })
    if (res.ok) {
      const note: Note = await res.json()
      setNotes(prev => [note, ...prev])
      setSelectedId(note.id)
      setLocalTitle(note.title)
      setLocalContent(note.content)
      setLocalFolder(note.folder)
      setMode('edit')
      setMobileView('editor')
      setTimeout(() => titleInputRef.current?.select(), 50)
    }
  }

  const deleteNote = async (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    const res = await fetch(`/api/notes/${id}`, { method: 'DELETE' })
    if (res.ok || res.status === 204) {
      setNotes(prev => prev.filter(n => n.id !== id))
      if (selectedId === id) {
        setSelectedId(null)
        setMobileView('list')
      }
    }
  }

  const selectNote = (id: string) => {
    // Flush pending save for current note before switching
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      if (selectedId) {
        fetch(`/api/notes/${selectedId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: localTitle, content: localContent, folder: localFolder }),
        })
          .then(r => r.ok ? r.json() : null)
          .then(updated => updated && setNotes(prev => prev.map(n => n.id === updated.id ? updated : n)))
          .catch(console.error)
      }
    }
    setSelectedId(id)
    setMode('edit')
    setMobileView('editor')
  }

  const toggleFolder = (folder: string) => {
    setCollapsedFolders(prev => {
      const next = new Set(prev)
      next.has(folder) ? next.delete(folder) : next.add(folder)
      return next
    })
  }

  // Filter notes by search
  const filteredNotes = notes.filter(n => {
    if (!search) return true
    const q = search.toLowerCase()
    return n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q)
  })

  const pinnedNotes = filteredNotes.filter(n => n.pinned)
  const unpinnedNotes = filteredNotes.filter(n => !n.pinned)

  // Group unpinned by folder
  const folders = Array.from(new Set(unpinnedNotes.map(n => n.folder))).sort()
  const notesByFolder: Record<string, Note[]> = {}
  for (const f of folders) {
    notesByFolder[f] = unpinnedNotes.filter(n => n.folder === f)
  }

  const NoteItem = ({ note }: { note: Note }) => {
    const active = note.id === selectedId
    return (
      <div
        onClick={() => selectNote(note.id)}
        className={`group relative flex flex-col gap-0.5 px-3 py-2 cursor-pointer rounded mx-1 transition-colors ${
          active ? 'bg-accent/10 text-accent' : 'hover:bg-bg-raised text-text-secondary hover:text-text-primary'
        }`}
      >
        <span className={`text-sm font-medium truncate pr-6 ${active ? 'text-accent' : ''}`}>
          {note.title || 'Untitled'}
        </span>
        <span className={`text-[11px] truncate ${active ? 'text-accent/70' : 'text-text-muted'}`}>
          {note.folder}
        </span>
        <button
          onClick={(e) => deleteNote(note.id, e)}
          className={`absolute right-2 top-2 p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity ${
            active ? 'text-accent/70 hover:text-accent' : 'text-text-muted hover:text-status-error'
          }`}
          title="Delete note"
        >
          <Trash2 size={13} />
        </button>
      </div>
    )
  }

  const FolderSection = ({ folder, items }: { folder: string; items: Note[] }) => {
    const collapsed = collapsedFolders.has(folder)
    return (
      <div>
        <button
          onClick={() => toggleFolder(folder)}
          className="flex items-center gap-1.5 w-full px-3 py-1.5 text-xs font-semibold text-text-muted hover:text-text-secondary uppercase tracking-wide transition-colors"
        >
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          <span className="truncate">{folder}</span>
          <span className="ml-auto font-normal normal-case tracking-normal opacity-60">{items.length}</span>
        </button>
        {!collapsed && items.map(n => <NoteItem key={n.id} note={n} />)}
      </div>
    )
  }

  // Left panel
  const LeftPanel = (
    <div className="flex flex-col h-full bg-bg-sidebar border-r border-border-subtle w-full md:w-[260px] flex-shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle flex-shrink-0">
        <span className="text-sm font-semibold text-text-primary">Notes</span>
        <button
          onClick={createNote}
          className="p-1 rounded text-text-muted hover:text-accent transition-colors"
          title="New note"
        >
          <Plus size={16} />
        </button>
      </div>

      {/* Search */}
      <div className="px-3 py-2 flex-shrink-0">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search notes..."
            className="w-full pl-8 pr-3 py-1.5 text-xs bg-bg-raised rounded border border-border-subtle text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent transition-colors"
          />
        </div>
      </div>

      {/* Note list */}
      <div className="flex-1 overflow-y-auto py-1">
        {filteredNotes.length === 0 && (
          <p className="px-4 py-3 text-xs text-text-muted">
            {search ? 'No notes match your search.' : 'No notes yet. Create one!'}
          </p>
        )}

        {/* Pinned section */}
        {pinnedNotes.length > 0 && (
          <div>
            <button
              onClick={() => toggleFolder('__pinned__')}
              className="flex items-center gap-1.5 w-full px-3 py-1.5 text-xs font-semibold text-text-muted hover:text-text-secondary uppercase tracking-wide transition-colors"
            >
              {collapsedFolders.has('__pinned__') ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              <Pin size={11} />
              <span>Pinned</span>
              <span className="ml-auto font-normal normal-case tracking-normal opacity-60">{pinnedNotes.length}</span>
            </button>
            {!collapsedFolders.has('__pinned__') && pinnedNotes.map(n => <NoteItem key={n.id} note={n} />)}
          </div>
        )}

        {/* Folder sections */}
        {folders.map(f => (
          <FolderSection key={f} folder={f} items={notesByFolder[f]} />
        ))}
      </div>
    </div>
  )

  // Right panel
  const RightPanel = (
    <div className="flex flex-col flex-1 min-w-0 h-full">
      {!selectedNote ? (
        <div className="flex-1 flex flex-col items-center justify-center text-text-muted gap-3">
          <FileText size={40} strokeWidth={1.2} className="opacity-40" />
          <p className="text-sm">Select a note or create a new one</p>
          <button
            onClick={createNote}
            className="flex items-center gap-2 px-3 py-1.5 text-sm rounded border border-border-subtle hover:border-accent hover:text-accent transition-colors"
          >
            <Plus size={14} />
            New Note
          </button>
        </div>
      ) : (
        <>
          {/* Toolbar */}
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border-subtle flex-shrink-0 flex-wrap gap-y-1">
            {/* Mobile back button */}
            <button
              onClick={() => setMobileView('list')}
              className="md:hidden p-1 text-text-muted hover:text-text-primary transition-colors mr-1"
              title="Back to list"
            >
              <ArrowLeft size={16} />
            </button>

            {/* Title */}
            <input
              ref={titleInputRef}
              value={localTitle}
              onChange={e => handleTitleChange(e.target.value)}
              className="flex-1 min-w-0 text-lg font-medium bg-transparent border-none outline-none text-text-primary placeholder:text-text-muted"
              placeholder="Note title..."
            />

            {/* Folder */}
            <input
              value={localFolder}
              onChange={e => handleFolderChange(e.target.value)}
              className="hidden sm:block w-28 text-xs bg-bg-raised border border-border-subtle rounded px-2 py-1 text-text-secondary focus:outline-none focus:border-accent transition-colors"
              placeholder="Folder"
              title="Folder"
            />

            {/* Pin */}
            <button
              onClick={handlePinToggle}
              title={selectedNote.pinned ? 'Unpin' : 'Pin'}
              className={`p-1.5 rounded transition-colors ${
                selectedNote.pinned
                  ? 'text-accent bg-accent/10'
                  : 'text-text-muted hover:text-accent'
              }`}
            >
              <Pin size={15} fill={selectedNote.pinned ? 'currentColor' : 'none'} />
            </button>

            {/* Edit/Preview toggle */}
            <div className="flex rounded border border-border-subtle overflow-hidden">
              <button
                onClick={() => setMode('edit')}
                title="Edit"
                className={`p-1.5 transition-colors ${
                  mode === 'edit' ? 'bg-accent/15 text-accent' : 'text-text-muted hover:text-text-secondary'
                }`}
              >
                <Pencil size={14} />
              </button>
              <button
                onClick={() => setMode('preview')}
                title="Preview"
                className={`p-1.5 border-l border-border-subtle transition-colors ${
                  mode === 'preview' ? 'bg-accent/15 text-accent' : 'text-text-muted hover:text-text-secondary'
                }`}
              >
                <Eye size={14} />
              </button>
            </div>

            {/* Delete */}
            <button
              onClick={() => deleteNote(selectedNote.id)}
              title="Delete note"
              className="p-1.5 rounded text-text-muted hover:text-status-error transition-colors"
            >
              <Trash2 size={15} />
            </button>
          </div>

          {/* Folder input for mobile */}
          <div className="sm:hidden px-4 py-1.5 border-b border-border-subtle flex-shrink-0">
            <input
              value={localFolder}
              onChange={e => handleFolderChange(e.target.value)}
              className="text-xs bg-bg-raised border border-border-subtle rounded px-2 py-1 text-text-secondary focus:outline-none focus:border-accent transition-colors w-full"
              placeholder="Folder"
            />
          </div>

          {/* Content area */}
          <div className="flex-1 overflow-hidden">
            {mode === 'edit' ? (
              <textarea
                value={localContent}
                onChange={e => handleContentChange(e.target.value)}
                placeholder="Write in markdown..."
                className="w-full h-full resize-none bg-bg-page text-text-primary font-mono text-sm p-4 focus:outline-none placeholder:text-text-muted leading-relaxed"
                spellCheck={false}
              />
            ) : (
              <div className="h-full overflow-y-auto px-6 py-4">
                {localContent ? (
                  <div className="max-w-3xl notes-prose">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm, remarkCallouts, [remarkEmoji, { accessible: true }]]}
                      rehypePlugins={[rehypeHighlight]}
                      components={{
                        h1: ({ children }) => (
                          <h1 className="text-2xl font-bold text-text-primary border-b border-border-subtle pb-2 mb-4 mt-6 first:mt-0">{children}</h1>
                        ),
                        h2: ({ children }) => (
                          <h2 className="text-xl font-semibold text-text-primary border-b border-border-subtle pb-1.5 mb-3 mt-5">{children}</h2>
                        ),
                        h3: ({ children }) => (
                          <h3 className="text-base font-semibold text-text-primary mb-2 mt-4">{children}</h3>
                        ),
                        h4: ({ children }) => (
                          <h4 className="text-sm font-semibold text-text-primary mb-1.5 mt-3">{children}</h4>
                        ),
                        p: ({ children }) => (
                          <p className="text-sm text-text-secondary leading-relaxed mb-3">{children}</p>
                        ),
                        ul: ({ children }) => (
                          <ul className="list-disc list-inside text-sm text-text-secondary space-y-1 mb-3 pl-2">{children}</ul>
                        ),
                        ol: ({ children }) => (
                          <ol className="list-decimal list-inside text-sm text-text-secondary space-y-1 mb-3 pl-2">{children}</ol>
                        ),
                        li: ({ children }) => (
                          <li className="text-sm text-text-secondary leading-relaxed">{children}</li>
                        ),
                        blockquote: ({ node, children }) => {
                          const callout = (node as { properties?: Record<string, unknown> })?.properties?.['data-callout'] as string | undefined
                          if (callout && CALLOUT_STYLES[callout]) {
                            const s = CALLOUT_STYLES[callout]
                            return (
                              <div className={`${s.border} ${s.bg} border-l-4 rounded-r px-4 py-3 mb-3`}>
                                <div className={`flex items-center gap-1.5 text-xs font-semibold ${s.label} mb-1.5`}>
                                  <span>{s.icon}</span>
                                  <span>{callout}</span>
                                </div>
                                <div className="text-sm text-text-secondary [&>p:last-child]:mb-0">{children}</div>
                              </div>
                            )
                          }
                          return <blockquote className="border-l-4 border-accent/40 pl-4 my-3 text-text-muted italic">{children}</blockquote>
                        },
                        code: ({ className, children }) => {
                          // Block code (has language class) — let rehype-highlight classes pass through
                          if (className) return <code className={className}>{children}</code>
                          // Inline code
                          return <code className="bg-bg-raised font-mono text-sm rounded px-1 py-0.5 text-text-primary">{children}</code>
                        },
                        pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
                        a: ({ href, children }) => (
                          <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">{children}</a>
                        ),
                        hr: () => <hr className="border-border-subtle my-4" />,
                        strong: ({ children }) => (
                          <strong className="font-semibold text-text-primary">{children}</strong>
                        ),
                        em: ({ children }) => (
                          <em className="italic text-text-secondary">{children}</em>
                        ),
                        table: ({ children }) => (
                          <div className="overflow-auto mb-3">
                            <table className="w-full text-sm border-collapse">{children}</table>
                          </div>
                        ),
                        thead: ({ children }) => (
                          <thead className="border-b border-border-subtle">{children}</thead>
                        ),
                        th: ({ children }) => (
                          <th className="text-left py-2 px-3 text-text-primary font-semibold">{children}</th>
                        ),
                        td: ({ children }) => (
                          <td className="py-2 px-3 text-text-secondary border-b border-border-subtle/50">{children}</td>
                        ),
                      }}
                    >
                      {localContent}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <p className="text-text-muted text-sm italic">Nothing to preview yet.</p>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )

  return (
    <div className="absolute inset-0 flex overflow-hidden">
      {/* Desktop: always show both panels */}
      <div className="hidden md:flex w-full h-full">
        {LeftPanel}
        {RightPanel}
      </div>

      {/* Mobile: toggle between panels */}
      <div className="flex md:hidden w-full h-full">
        {mobileView === 'list' ? LeftPanel : RightPanel}
      </div>
    </div>
  )
}
