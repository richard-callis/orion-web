import { Terminal, Loader2 } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import 'highlight.js/styles/github-dark.css'

interface ToolCall {
  tool: string
  input: string
  output?: string
}

interface Message {
  role: 'user' | 'assistant'
  content: string
  toolCalls?: ToolCall[]
  streaming?: boolean
}

export function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user'

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] space-y-2 ${isUser ? 'items-end' : 'items-start'} flex flex-col`}>
        {/* Tool calls (AG-UI style) */}
        {!isUser && message.toolCalls?.map((tc, i) => (
          <div key={i} className="w-full rounded-lg border border-status-info/30 bg-status-info/5 text-xs overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-status-info/20 bg-status-info/10">
              <Terminal size={12} className="text-status-info" />
              <span className="font-mono text-status-info">{tc.tool}</span>
            </div>
            <div className="px-3 py-2 font-mono text-text-secondary break-all">{tc.input}</div>
            {tc.output && (
              <div className="px-3 py-2 border-t border-status-info/20 font-mono text-text-muted whitespace-pre-wrap max-h-48 overflow-y-auto">
                {tc.output}
              </div>
            )}
          </div>
        ))}

        {/* Message bubble */}
        {(message.content || message.streaming) && (
          <div className={`rounded-lg px-4 py-2.5 text-sm leading-relaxed ${
            isUser
              ? 'bg-accent text-white'
              : 'bg-bg-card border border-border-subtle text-text-primary'
          }`}>
            {isUser ? (
              // User messages: plain text
              <span>{message.content}</span>
            ) : message.content ? (
              // Assistant messages: render markdown
              <div className="prose-mcc">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeHighlight]}
                  components={{
                    // Inline code (no language)
                    code({ className, children, ...props }) {
                      const isBlock = className?.startsWith('language-')
                      if (isBlock) {
                        return (
                          <code className={className} {...props}>
                            {children}
                          </code>
                        )
                      }
                      return (
                        <code className="bg-bg-raised border border-border-subtle rounded px-1 py-0.5 font-mono text-[0.85em] text-accent" {...props}>
                          {children}
                        </code>
                      )
                    },
                    // Code block wrapper
                    pre({ children }) {
                      return (
                        <pre className="bg-[#0d1117] border border-border-subtle rounded-lg overflow-x-auto p-3 my-2 text-xs leading-relaxed">
                          {children}
                        </pre>
                      )
                    },
                    // Headings
                    h1({ children }) { return <h1 className="text-base font-bold mt-3 mb-1">{children}</h1> },
                    h2({ children }) { return <h2 className="text-sm font-bold mt-3 mb-1">{children}</h2> },
                    h3({ children }) { return <h3 className="text-sm font-semibold mt-2 mb-1">{children}</h3> },
                    // Paragraphs
                    p({ children }) { return <p className="mb-2 last:mb-0">{children}</p> },
                    // Lists
                    ul({ children }) { return <ul className="list-disc list-inside mb-2 space-y-0.5">{children}</ul> },
                    ol({ children }) { return <ol className="list-decimal list-inside mb-2 space-y-0.5">{children}</ol> },
                    li({ children }) { return <li className="text-text-primary">{children}</li> },
                    // Blockquote
                    blockquote({ children }) {
                      return (
                        <blockquote className="border-l-2 border-accent pl-3 my-2 text-text-secondary italic">
                          {children}
                        </blockquote>
                      )
                    },
                    // Bold / italic
                    strong({ children }) { return <strong className="font-semibold text-text-primary">{children}</strong> },
                    em({ children }) { return <em className="italic">{children}</em> },
                    // Horizontal rule
                    hr() { return <hr className="border-border-subtle my-3" /> },
                    // Links
                    a({ href, children }) {
                      return (
                        <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent underline hover:text-accent/80">
                          {children}
                        </a>
                      )
                    },
                    // Tables
                    table({ children }) {
                      return (
                        <div className="overflow-x-auto my-2">
                          <table className="text-xs border-collapse w-full">{children}</table>
                        </div>
                      )
                    },
                    thead({ children }) { return <thead className="border-b border-border-visible">{children}</thead> },
                    th({ children }) { return <th className="px-3 py-1.5 text-left font-semibold text-text-secondary">{children}</th> },
                    td({ children }) { return <td className="px-3 py-1.5 border-t border-border-subtle">{children}</td> },
                  }}
                >
                  {message.content}
                </ReactMarkdown>
                {message.streaming && (
                  <span className="inline-block w-1.5 h-4 bg-text-secondary ml-0.5 animate-pulse align-middle" />
                )}
              </div>
            ) : message.streaming ? (
              <Loader2 size={14} className="animate-spin text-text-muted" />
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}
