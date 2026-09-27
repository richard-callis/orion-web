'use client'
import { memo } from 'react'
import { Bot, User as UserIcon, BookmarkCheck, Terminal, Layers } from 'lucide-react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { RoomMessage, ToolCallAttachment } from './types'

/** Render message content with @mention highlighting */
function MessageContent({ content }: { content: string }) {
  const parts = content.split(/(@[\w-]+)/g)
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === '@everyone'
          ? <span key={i} className="text-yellow-400 font-semibold">{part}</span>
          : part.startsWith('@')
          ? <span key={i} className="text-accent font-medium">{part}</span>
          : <span key={i}>{part}</span>
      )}
    </>
  )
}

// Hoisted so ReactMarkdown gets a stable components object across renders.
const MARKDOWN_COMPONENTS: Components = {
  code({ className, children, ...props }) {
    const isBlock = className?.startsWith('language-')
    if (isBlock) return <code className={className} {...props}>{children}</code>
    return <code className="bg-bg-raised border border-border-subtle rounded px-1 py-0.5 font-mono text-[0.85em] text-accent" {...props}>{children}</code>
  },
  pre({ children }) {
    return <pre className="bg-[#0d1117] border border-border-subtle rounded-lg overflow-x-auto p-3 my-2 text-xs leading-relaxed">{children}</pre>
  },
  h1({ children }) { return <h1 className="text-base font-bold mt-3 mb-1">{children}</h1> },
  h2({ children }) { return <h2 className="text-sm font-bold mt-3 mb-1">{children}</h2> },
  h3({ children }) { return <h3 className="text-sm font-semibold mt-2 mb-1">{children}</h3> },
  p({ children }) { return <p className="mb-2 last:mb-0">{children}</p> },
  ul({ children }) { return <ul className="list-disc list-inside mb-2 space-y-0.5">{children}</ul> },
  ol({ children }) { return <ol className="list-decimal list-inside mb-2 space-y-0.5">{children}</ol> },
  li({ children }) { return <li className="text-text-primary">{children}</li> },
  blockquote({ children }) {
    return <blockquote className="border-l-2 border-accent pl-3 my-2 text-text-secondary italic">{children}</blockquote>
  },
  strong({ children }) { return <strong className="font-semibold text-text-primary">{children}</strong> },
  em({ children }) { return <em className="italic">{children}</em> },
  hr() { return <hr className="border-border-subtle my-3" /> },
  a({ href, children }) {
    return <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent underline hover:text-accent/80">{children}</a>
  },
  table({ children }) {
    return <div className="overflow-x-auto my-2"><table className="text-xs border-collapse w-full">{children}</table></div>
  },
  thead({ children }) { return <thead className="border-b border-border-visible">{children}</thead> },
  th({ children }) { return <th className="px-3 py-1.5 text-left font-semibold text-text-secondary">{children}</th> },
  td({ children }) { return <td className="px-3 py-1.5 border-t border-border-subtle">{children}</td> },
}

const REMARK_PLUGINS = [remarkGfm]
const REHYPE_PLUGINS = [rehypeHighlight]

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/**
 * A single chat message row, memoized so typing in the message box doesn't
 * force every message — including agent replies, each running full
 * ReactMarkdown + remark-gfm + rehype-highlight — to re-render on every keystroke.
 */
export const ChatMessageItem = memo(function ChatMessageItem({
  msg, isPlanningRoom, isHovered, isSaved, onHover, onSaveAsPlan,
}: {
  msg: RoomMessage
  isPlanningRoom: boolean
  isHovered: boolean
  isSaved: boolean
  onHover: (id: string | null) => void
  onSaveAsPlan: (id: string, content: string) => void
}) {
  const planLineCount = isPlanningRoom ? (msg.content.match(/^\d+[.)]/gm) ?? []).length : 0
  const autoPlan = planLineCount >= 3
  const fromHuman = msg.sender?.type === 'human' || msg.sender?.type === 'user'

  return (
    <div
      className={`max-w-[80%] relative group ${msg.senderType === 'system' ? 'mx-auto text-center' : fromHuman ? 'ml-auto' : 'mr-auto'}`}
      onMouseEnter={() => onHover(msg.id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(msg.id)}
    >
      {msg.senderType === 'system' ? (
        <div className="text-[10px] text-text-muted py-1">{msg.content}</div>
      ) : msg.senderType === 'compaction' ? (
        <div className="w-full rounded-lg border border-status-warning/30 bg-status-warning/5 text-xs overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-status-warning/20 bg-status-warning/10">
            <Layers size={12} className="text-status-warning" />
            <span className="font-mono text-status-warning">context compacted</span>
            <span className="ml-auto text-[9px] text-status-warning/60 font-sans">{timeOf(msg.createdAt)}</span>
          </div>
          <div className="px-3 py-2 font-mono text-text-muted whitespace-pre-wrap max-h-48 overflow-y-auto">{msg.content}</div>
        </div>
      ) : msg.senderType === 'tool_call' ? (
        <ToolCallCard msg={msg} />
      ) : (
        <div className={`rounded-lg px-3 py-2 ${fromHuman ? 'bg-accent/20 text-text-primary' : 'bg-bg-raised border border-border-subtle text-text-primary'}`}>
          <div className="flex items-center gap-1.5 mb-1">
            {msg.sender?.type === 'agent' ? <Bot size={11} className="text-accent" /> : <UserIcon size={11} />}
            <span className="text-[10px] font-medium text-text-secondary">{msg.sender?.name}</span>
            <span className="text-[9px] text-text-muted">{timeOf(msg.createdAt)}</span>
            {isSaved && (
              <span className="ml-auto text-[9px] text-status-healthy font-medium flex items-center gap-0.5">
                <BookmarkCheck size={10} /> Saved
              </span>
            )}
          </div>
          {fromHuman ? (
            <p className="text-xs leading-relaxed whitespace-pre-wrap"><MessageContent content={msg.content} /></p>
          ) : (
            <div className="prose-orion text-xs">
              <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={MARKDOWN_COMPONENTS}>
                {msg.content}
              </ReactMarkdown>
            </div>
          )}
          {isPlanningRoom && (autoPlan || isHovered) && !isSaved && (
            <button
              onClick={() => onSaveAsPlan(msg.id, msg.content)}
              className="mt-1.5 flex items-center gap-1 text-[10px] text-accent hover:text-accent/80 transition-colors"
            >
              <BookmarkCheck size={11} /> Save as Plan
            </button>
          )}
        </div>
      )}
    </div>
  )
})

function ToolCallCard({ msg }: { msg: RoomMessage }) {
  const tc = msg.attachments as ToolCallAttachment | null
  return (
    <div className="w-full rounded-lg border border-status-info/30 bg-status-info/5 text-xs overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-status-info/20 bg-status-info/10">
        <Terminal size={12} className="text-status-info" />
        <span className="font-mono text-status-info">{tc?.tool ?? msg.content}</span>
        {msg.sender?.name && (
          <span className="ml-auto text-[9px] text-status-info/60 font-sans">{msg.sender.name}</span>
        )}
      </div>
      {tc?.output && (
        <div className="px-3 py-2 border-t border-status-info/20 font-mono text-text-muted whitespace-pre-wrap max-h-48 overflow-y-auto">{tc.output}</div>
      )}
    </div>
  )
}
