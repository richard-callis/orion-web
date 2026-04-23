'use client'
import { useEffect } from 'react'

/**
 * Converts consecutive <div data-tab-group="tg-N"> blocks into interactive tab UI.
 * The parent page preprocesses > [!TAB label]...[/TABS] blocks into these divs.
 */
export function Tabs({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const container = document.querySelector('.notes-prose')
    if (!container) return

    const allDivs = container.querySelectorAll<HTMLDivElement>('div[data-tab-group]')
    if (allDivs.length === 0) return

    // Group consecutive divs by their group ID
    const groups: HTMLDivElement[][] = []
    let current: HTMLDivElement[] = []
    let currentGid = ''

    for (const div of allDivs) {
      const gid = div.getAttribute('data-tab-group') || ''
      if (gid === currentGid && current.length > 0) {
        current.push(div)
      } else {
        if (current.length > 1) groups.push(current)
        current = [div]
        currentGid = gid
      }
    }
    if (current.length > 1) groups.push(current)

    // Render each group as tabs
    for (const divs of groups) {
      const gid = divs[0].getAttribute('data-tab-group') || ''
      const win = window as unknown as { _activeTab?: Record<string, number> }
      if (!win._activeTab) win._activeTab = {}
      const activeIdx = win._activeTab[gid] ?? 0

      // Build tab bar
      const tabBar = document.createElement('div')
      tabBar.className = 'flex gap-0.5 mb-3 border-b border-border-subtle flex-wrap'

      divs.forEach((div, i) => {
        const btn = document.createElement('button')
        btn.className = `px-3 py-1.5 text-xs font-medium rounded-t border-b-2 transition-colors whitespace-nowrap ${
          i === activeIdx
            ? 'text-accent border-accent bg-accent/5'
            : 'text-text-muted border-transparent hover:text-text-secondary hover:border-border-subtle'
        }`
        // Get label from first heading or first line of text
        const h = div.querySelector('h2, h3, h4, strong')
        btn.textContent = h?.textContent?.trim() || div.textContent?.split('\n')[0]?.trim() || `Tab ${i + 1}`
        btn.addEventListener('click', () => switchTab(i))
        tabBar.appendChild(btn)
      })

      // Build content panels
      const contentWrapper = document.createElement('div')
      contentWrapper.className = 'note-tab-content-wrapper'

      divs.forEach((div, i) => {
        const panel = document.createElement('div')
        panel.className = 'note-tab-panel'
        panel.style.display = i === activeIdx ? '' : 'none'
        panel.innerHTML = div.innerHTML
        contentWrapper.appendChild(panel)
      })

      const switchTab = (idx: number) => {
        if (idx === activeIdx) return
        win._activeTab![gid] = idx
        const buttons = tabBar.querySelectorAll('button')
        buttons.forEach((b, bi) => {
          b.className = `px-3 py-1.5 text-xs font-medium rounded-t border-b-2 transition-colors whitespace-nowrap ${
            bi === idx
              ? 'text-accent border-accent bg-accent/5'
              : 'text-text-muted border-transparent hover:text-text-secondary hover:border-border-subtle'
          }`
        })
        const panels = contentWrapper.querySelectorAll('.note-tab-panel')
        panels.forEach((p, pi) => {
          ;(p as HTMLElement).style.display = pi === idx ? '' : 'none'
        })
      }

      // Build wrapper and replace
      const wrapper = document.createElement('div')
      wrapper.className = 'note-tabs-wrapper mb-4'
      wrapper.appendChild(tabBar)
      wrapper.appendChild(contentWrapper)

      // Insert wrapper before first div, remove all divs
      divs[0].parentNode?.insertBefore(wrapper, divs[0])
      divs.forEach(d => d.remove())
    }
  }, [children])

  return <>{children}</>
}
