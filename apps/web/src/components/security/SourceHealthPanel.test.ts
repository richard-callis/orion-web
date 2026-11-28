/** SourceHealthPanel: error banner, not_configured styling and counts. Rendered server-side (no DOM env in this repo). */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const h = vi.hoisted(() => ({ swr: {} as any }))
vi.mock('swr', () => ({ default: () => h.swr }))
vi.mock('@/hooks/useSSE', () => ({ useEventSource: () => {} }))

import SourceHealthPanel from './SourceHealthPanel'

const render = () => renderToStaticMarkup(createElement(SourceHealthPanel))
const src = (over: Record<string, unknown>) => ({
  source: 'unifi', lastSeenAt: null, lastWatermark: null, staleAfterMs: 300_000,
  environmentId: null, alertCount24h: 0, status: 'not_configured', ...over,
})

beforeEach(() => { h.swr = { data: undefined, error: undefined, isLoading: false, mutate: vi.fn() } })

describe('SourceHealthPanel', () => {
  it('shows the error banner (not the empty state) when the fetch fails', () => {
    h.swr.error = new Error('boom')
    const html = render()
    expect(html).toContain('Could not load source health')
    expect(html).toContain('Retry')
    expect(html).not.toContain('No monitoring sources configured')
  })

  it('keeps last data under the banner', () => {
    h.swr.error = new Error('boom')
    h.swr.data = { sources: [src({ source: 'crowdsec', status: 'healthy', lastSeenAt: new Date().toISOString() })] }
    const html = render()
    expect(html).toContain('showing last data')
    expect(html).toContain('CrowdSec')
  })

  it('renders not_configured grey and outside the counts; groups per-env rows under the environment', () => {
    h.swr.data = { sources: [
      src({ source: 'crowdsec', status: 'healthy', lastSeenAt: new Date().toISOString() }),
      src({ source: 'unifi' }),
      src({ source: 'k8s_inventory', environmentId: 'e1', environmentName: 'prod' }),
    ] }
    const html = render()
    expect(html).toContain('1 healthy')
    expect(html).toContain('2 not configured')
    expect(html).not.toMatch(/\d+( )? down/)
    expect(html).toMatch(/text-text-muted">not configured<\/span>/)
    expect(html).toContain('opacity-60')
    expect(html).toContain('Environment: prod')
  })

  it('a not_configured-only render shows no last-seen details', () => {
    h.swr.data = { sources: [src({ source: 'unifi' })] }
    expect(render()).not.toContain('Last seen')
  })

  it('hides the counts row when the first fetch failed', () => {
    h.swr.error = new Error('boom')
    expect(render()).not.toContain('healthy')
  })
})
