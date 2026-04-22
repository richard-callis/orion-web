'use client'
import { useCallback, useMemo, useState, useRef, useEffect } from 'react'
import ForceGraph2D from 'react-force-graph-2d'
import { Search, X, ArrowLeft } from 'lucide-react'
import { useRouter } from 'next/navigation'

interface GraphNode {
  id: string
  title: string
  type: string
  folder: string
  pinned: boolean
}

interface GraphLink {
  source: string
  target: string
  type?: 'wikilink' | 'semantic'
  score?: number
}

interface GraphData {
  nodes: GraphNode[]
  links: GraphLink[]
  counts?: { wikilinks: number; semantic: number }
}

const CATEGORY_COLORS: Record<string, string> = {
  wiki: '#60a5fa',
  runbook: '#f59e0b',
  'llm-context': '#a78bfa',
  note: '#94a3b8',
}

const SEMANTIC_EDGE_COLOR = '#00A7E1' // accent color
const WIKILINK_COLOR = '#475569'

export function GraphView() {
  const router = useRouter()
  const [data, setData] = useState<GraphData | null>(null)
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null)
  const [highlightedNodes, setHighlightedNodes] = useState<Set<string>>(new Set())
  const [highlightedLinks, setHighlightedLinks] = useState<Set<string>>(new Set())
  const [showSemantic, setShowSemantic] = useState(true)
  const [showWikilinks, setShowWikilinks] = useState(true)
  const fgRef = useRef<any>(null)

  // Fetch graph data on mount
  useEffect(() => {
    fetch('/api/notes/graph-data')
      .then(r => r.json())
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  // Filter nodes by search
  const filteredNodes = useMemo(() => {
    if (!data) return []
    if (!searchTerm) return data.nodes
    const q = searchTerm.toLowerCase()
    return data.nodes.filter(n =>
      n.title.toLowerCase().includes(q) ||
      n.folder.toLowerCase().includes(q) ||
      n.type.toLowerCase().includes(q),
    )
  }, [data, searchTerm])

  // Visible links (respects toggles)
  const visibleLinks = useMemo(() => {
    if (!data) return []
    return data.links.filter(l => {
      if (l.type === 'semantic' && !showSemantic) return false
      if (l.type === 'wikilink' && !showWikilinks) return false
      return true
    })
  }, [data, showSemantic, showWikilinks])

  // Handle node click
  const handleNodeClick = useCallback((node: GraphNode) => {
    setSelectedNode(node)
    setHighlightedNodes(new Set([node.id]))
    setHighlightedLinks(new Set())

    if (visibleLinks) {
      const connected = new Set<string>()
      for (const link of visibleLinks) {
        if (link.source === node.id || link.target === node.id) {
          connected.add(linkKey(link))
        }
      }
      setHighlightedLinks(connected)
    }
  }, [visibleLinks])

  // Handle node hover
  const handleNodeHover = useCallback((node: GraphNode | null) => {
    if (!node) {
      setHighlightedNodes(new Set())
      setHighlightedLinks(new Set())
      return
    }

    const nodes = new Set<string>([node.id])
    const links = new Set<string>()

    if (visibleLinks) {
      for (const link of visibleLinks) {
        if (link.source === node.id || link.target === node.id) {
          nodes.add(link.source)
          nodes.add(link.target)
          links.add(linkKey(link))
        }
      }
    }

    setHighlightedNodes(nodes)
    setHighlightedLinks(links)
  }, [visibleLinks])

  // Zoom to node on click
  useEffect(() => {
    if (selectedNode && fgRef.current) {
      fgRef.current.zoom(2.5)
      fgRef.current.centerAt(0, 0, 800)
    }
  }, [selectedNode])

  const linkKey = (link: GraphLink) => `${link.source}->${link.target}`

  const nodeColor = (node: GraphNode) => {
    if (highlightedNodes.size > 0 && !highlightedNodes.has(node.id)) return '#334155'
    return CATEGORY_COLORS[node.type] || CATEGORY_COLORS.note
  }

  const linkColor = (link: GraphLink) => {
    if (highlightedLinks.size > 0 && !highlightedLinks.has(linkKey(link))) return '#1e293b'
    return link.type === 'semantic' ? SEMANTIC_EDGE_COLOR : WIKILINK_COLOR
  }

  const linkWidth = (link: GraphLink) => {
    if (highlightedLinks.size > 0 && !highlightedLinks.has(linkKey(link))) return 0.5
    return link.type === 'semantic' ? 1.2 : 1.5
  }

  // Build link info (for display)
  const getLinkInfo = useCallback((link: GraphLink): { label: string; score?: number } | null => {
    if (link.type === 'semantic') {
      return { label: 'Semantic match', score: link.score }
    }
    return { label: 'Wikilink' }
  }, [])

  // Connections for selected node (split by type)
  const { wikilinkConnections, semanticConnections } = useMemo(() => {
    if (!selectedNode || !data) return { wikilinkConnections: [], semanticConnections: [] }
    const wikis: GraphLink[] = []
    const sems: GraphLink[] = []
    for (const link of data.links) {
      if ((link.source === selectedNode.id || link.target === selectedNode.id) &&
          (link.type !== 'semantic' || showSemantic) &&
          (link.type !== 'wikilink' || showWikilinks)) {
        if (link.type === 'semantic') sems.push(link)
        else wikis.push(link)
      }
    }
    return { wikilinkConnections: wikis, semanticConnections: sems }
  }, [selectedNode, data, showSemantic, showWikilinks])

  const targetNode = useCallback(
    (link: GraphLink) => {
      const isOutgoing = link.source === selectedNode?.id
      const targetId = isOutgoing ? link.target : link.source
      return data?.nodes.find(n => n.id === targetId)
    },
    [selectedNode, data],
  )

  return (
    <div className="absolute inset-0 flex">
      {/* Graph canvas */}
      <div className="flex-1 relative bg-[#0f172a]">
        {loading ? (
          <div className="flex items-center justify-center h-full text-text-muted text-sm">
            Loading knowledge graph...
          </div>
        ) : (
          <ForceGraph2D
            ref={fgRef as any}
            graphData={data || { nodes: [], links: [] }}
            nodeColor={nodeColor}
            nodeRelSize={4}
            nodeLabel={(node: GraphNode) => `${node.title} (${node.type})`}
            onNodeClick={handleNodeClick}
            onNodeHover={handleNodeHover}
            linkColor={linkColor}
            linkWidth={linkWidth}
            linkDirectionalDashArray={[4, 4]}
            backgroundColor="#0f172a"
            cooldownTicks={100}
          />
        )}

        {/* Search overlay */}
        <div className="absolute top-3 left-3 right-3 max-w-md">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              placeholder="Search nodes..."
              className="w-full pl-8 pr-8 py-2 text-sm bg-slate-800/90 backdrop-blur border border-slate-700 rounded text-text-primary placeholder:text-text-muted focus:outline-none focus:border-blue-500 transition-colors"
            />
            {searchTerm && (
              <button
                onClick={() => setSearchTerm('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
              >
                <X size={14} />
              </button>
            )}
          </div>
        </div>

        {/* Edge type toggles */}
        <div className="absolute bottom-3 left-3 flex items-center gap-3">
          {/* Edge type legend */}
          <div className="flex items-center gap-2 text-xs">
            <button
              onClick={() => setShowWikilinks(v => !v)}
              className={`flex items-center gap-1.5 px-2 py-1 rounded transition-colors ${
                showWikilinks ? 'text-text-secondary' : 'text-text-muted opacity-40'
              }`}
            >
              <div className={`w-2 h-0.5 rounded`} style={{ backgroundColor: WIKILINK_COLOR }} />
              <span>Wikilink</span>
            </button>
            <button
              onClick={() => setShowSemantic(v => !v)}
              className={`flex items-center gap-1.5 px-2 py-1 rounded transition-colors ${
                showSemantic ? 'text-text-secondary' : 'text-text-muted opacity-40'
              }`}
            >
              <div className="w-2 h-0.5 rounded" style={{ backgroundColor: SEMANTIC_EDGE_COLOR }} />
              <span>Semantic</span>
            </button>
          </div>

          {/* Edge count summary */}
          {data?.counts && (
            <div className="text-[10px] text-text-muted">
              {data.counts.wikilinks} wiki · {data.counts.semantic} semantic
            </div>
          )}
        </div>

        {/* Back button */}
        <button
          onClick={() => router.push('/notes')}
          className="absolute top-3 right-3 p-2 rounded bg-slate-800/90 backdrop-blur border border-slate-700 text-text-muted hover:text-text-primary transition-colors"
          title="Back to Notes"
        >
          <ArrowLeft size={16} />
        </button>
      </div>

      {/* Node info panel */}
      {selectedNode && (
        <div className="hidden md:flex w-56 flex-shrink-0 bg-bg-sidebar border-l border-border-subtle flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
            <span className="text-sm font-semibold text-text-primary">Node Details</span>
            <button
              onClick={() => setSelectedNode(null)}
              className="p-1 text-text-muted hover:text-text-primary rounded"
            >
              <X size={14} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            <h3 className="font-medium text-text-primary">{selectedNode.title}</h3>
            <div className="space-y-1 text-xs">
              <div>
                <span className="text-text-muted">Type:</span>{' '}
                <span className="text-text-secondary capitalize">{selectedNode.type}</span>
              </div>
              <div>
                <span className="text-text-muted">Folder:</span>{' '}
                <span className="text-text-secondary">{selectedNode.folder}</span>
              </div>
              <div>
                <span className="text-text-muted">Pinned:</span>{' '}
                <span className="text-text-secondary">{selectedNode.pinned ? 'Yes' : 'No'}</span>
              </div>
            </div>

            {/* Wikilink connections */}
            {wikilinkConnections.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-1.5">
                  Wikilinks ({wikilinkConnections.length})
                </h4>
                <div className="space-y-0.5">
                  {wikilinkConnections.map(link => {
                    const target = targetNode(link)
                    if (!target) return null
                    const isOutgoing = link.source === selectedNode.id
                    return (
                      <button
                        key={linkKey(link)}
                        onClick={() => handleNodeClick(target)}
                        className="flex items-center gap-1 w-full text-left text-xs text-text-secondary hover:text-text-primary py-0.5 truncate"
                      >
                        <span className="text-[10px] opacity-60">{isOutgoing ? '→' : '←'}</span>
                        <span className="truncate">{target.title}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Semantic connections */}
            {semanticConnections.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold text-accent uppercase tracking-wide mb-1.5">
                  Semantic ({semanticConnections.length})
                </h4>
                <div className="space-y-0.5">
                  {semanticConnections.map(link => {
                    const target = targetNode(link)
                    if (!target) return null
                    return (
                      <button
                        key={linkKey(link)}
                        onClick={() => handleNodeClick(target)}
                        className="flex items-center gap-1 w-full text-left text-xs text-accent/80 hover:text-accent py-0.5 truncate"
                      >
                        <span className="text-[10px] opacity-60">{link.score?.toFixed(2)}</span>
                        <span className="truncate">{target.title}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
