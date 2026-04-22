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

interface GraphEdge {
  source: string
  target: string
}

interface GraphData {
  nodes: GraphNode[]
  links: GraphEdge[]
}

// Transform edges→links for react-force-graph-2d
function toGraphData(notes: GraphNode[], edges: GraphEdge[]): GraphData {
  return {
    nodes: notes,
    links: edges.map(e => ({ source: e.source, target: e.target })),
  }
}

const CATEGORY_COLORS: Record<string, string> = {
  wiki: '#60a5fa',
  runbook: '#f59e0b',
  'llm-context': '#a78bfa',
  note: '#94a3b8',
}

export function GraphView() {
  const router = useRouter()
  const [data, setData] = useState<GraphData | null>(null)
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null)
  const [highlightedNodes, setHighlightedNodes] = useState<Set<string>>(new Set())
  const [highlightedEdges, setHighlightedEdges] = useState<Set<string>>(new Set())
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

  const validNodeIds = useMemo(() => new Set(filteredNodes.map(n => n.id)), [filteredNodes])

  // Handle node click
  const handleNodeClick = useCallback((node: GraphNode) => {
    setSelectedNode(node)
    setHighlightedNodes(new Set([node.id]))
    setHighlightedEdges(new Set())

    if (data) {
      const connected = new Set<string>()
      for (const link of data.links) {
        if (link.source === node.id || link.target === node.id) {
          connected.add(`${link.source}->${link.target}`)
        }
      }
      setHighlightedEdges(connected)
    }
  }, [data])

  // Handle node hover
  const handleNodeHover = useCallback((node: GraphNode | null) => {
    if (!node) {
      setHighlightedNodes(new Set())
      setHighlightedEdges(new Set())
      return
    }

    const nodes = new Set<string>([node.id])
    const edges = new Set<string>()

    if (data) {
      for (const link of data.links) {
        if (link.source === node.id || link.target === node.id) {
          nodes.add(link.source)
          nodes.add(link.target)
          edges.add(`${link.source}->${link.target}`)
        }
      }
    }

    setHighlightedNodes(nodes)
    setHighlightedEdges(edges)
  }, [data])

  // Zoom to node on click
  useEffect(() => {
    if (selectedNode && fgRef.current) {
      fgRef.current.zoom(2.5)
      fgRef.current.centerAt(0, 0, 800)
    }
  }, [selectedNode])

  const linkKey = (link: GraphEdge) => `${link.source}->${link.target}`

  const nodeColor = (node: GraphNode) => {
    if (highlightedNodes.size > 0 && !highlightedNodes.has(node.id)) return '#334155'
    return CATEGORY_COLORS[node.type] || CATEGORY_COLORS.note
  }

  const linkColor = (link: GraphEdge) => {
    if (highlightedEdges.size > 0 && !highlightedEdges.has(linkKey(link))) return '#1e293b'
    return '#475569'
  }

  const linkWidth = (link: GraphEdge) => {
    if (highlightedEdges.size > 0 && !highlightedEdges.has(linkKey(link))) return 0.5
    return 1.5
  }

  // Compute links from selected node
  const selectedLinks = useMemo(() => {
    if (!selectedNode || !data) return []
    return data.links.filter(l => l.source === selectedNode.id || l.target === selectedNode.id)
  }, [selectedNode, data])

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
            backgroundColor="#0f172a"
            cooldownTicks={100}
            onEngineStop={() => {
              // Auto-center after layout settles
            }}
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

        {/* Legend */}
        <div className="absolute bottom-3 left-3 flex gap-3 text-xs text-text-muted">
          {Object.entries(CATEGORY_COLORS).map(([type, color]) => (
            <div key={type} className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
              <span className="capitalize">{type}</span>
            </div>
          ))}
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

            {/* Connections */}
            {selectedLinks.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-1.5">
                  Connections ({selectedLinks.length})
                </h4>
                <div className="space-y-0.5">
                  {selectedLinks.map(link => {
                    const isOutgoing = link.source === selectedNode.id
                    const targetId = isOutgoing ? link.target : link.source
                    const targetNode = data?.nodes.find(n => n.id === targetId)
                    return targetNode ? (
                      <button
                        key={`${link.source}->${link.target}`}
                        onClick={() => handleNodeClick(targetNode)}
                        className="flex items-center gap-1 w-full text-left text-xs text-accent hover:underline py-0.5"
                      >
                        <span className="text-[10px]">{isOutgoing ? '→' : '←'}</span>
                        <span className="truncate">{targetNode.title}</span>
                      </button>
                    ) : null
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
