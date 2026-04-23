/**
 * Remark plugin: converts consecutive > [!TAB label] blockquotes into
 * <div data-tab-group> elements. Consecutive tabs get the same group ID.
 * Must run BEFORE remarkCallouts.
 */
export function remarkTabs() {
  return (tree: { children: unknown[] }) => {
    // First pass: collect all tab blockquotes and group them
    const tabIndices: number[] = []

    function findTabs(nodes: unknown[]) {
      if (!Array.isArray(nodes)) return
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i] as { type: string; children?: unknown[] }
        if (n?.type === 'blockquote' && n.children?.length) {
          const first = n.children[0] as { type: string; children?: Array<{ value?: string }> }
          if (first?.type === 'paragraph' && first.children?.length) {
            const text = (first.children[0] as { value?: string })?.value ?? ''
            if (/^\[!TAB\s/.test(text)) {
              tabIndices.push(i)
            }
          }
        }
        if (n?.children) findTabs(n.children)
      }
    }
    findTabs(tree.children)

    // Second pass: assign group IDs to consecutive tabs
    const groups: number[][] = []
    if (tabIndices.length === 0) return

    let currentGroup = [tabIndices[0]]
    for (let i = 1; i < tabIndices.length; i++) {
      currentGroup.push(tabIndices[i])
    }
    groups.push(currentGroup)

    // Third pass: transform blockquotes
    function transform(nodes: unknown[]) {
      if (!Array.isArray(nodes)) return
      for (let g = 0; g < groups.length; g++) {
        const group = groups[g]
        for (const idx of group) {
          const n = nodes[idx] as { type: string; children?: unknown[] }
          if (n?.type === 'blockquote') {
            const first = n.children?.[0] as { type: string; children?: Array<{ value?: string }> }
            const firstText = first?.children?.[0] as { value?: string }
            const raw = firstText?.value ?? ''
            const label = /^\[!TAB\s+([^\]]+)\]/.exec(raw)?.[1]?.trim() || `Tab ${g + 1}`

            // Children after the first paragraph
            const content = n.children?.slice(1) ?? []

            // The first paragraph might have text after [!TAB ...] — keep it
            const afterText = /^\[!TAB\s+[^\]]+\]\s*(.*)/.exec(raw)?.[1]?.trim()
            const firstPara = firstText ? {
              type: 'paragraph',
              children: [{ type: 'text', value: afterText || '' }],
            } : null

            nodes[idx] = {
              type: 'element',
              tagName: 'div',
              properties: {
                className: ['tab-content'],
                'data-tab-group': `tg-${g}`,
                'data-tab-label': label,
              },
              children: [firstPara, ...(content || [])].filter(Boolean),
            } as unknown
          }
        }
      }
      // Recurse into nested structures
      for (const node of nodes) {
        const n = node as { children?: unknown[] }
        if (n?.children) transform(n.children)
      }
    }
    transform(tree.children)
  }
}
