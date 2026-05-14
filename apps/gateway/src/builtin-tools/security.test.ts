import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { securityTools } from './security'

describe('Security Tools', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.clearAllMocks()
    // Clear all security-related env vars
    delete process.env.CROWDSEC_API
    delete process.env.CROWDSEC_API_KEY
    delete process.env.NTOPNG_API
    delete process.env.ELASTICSEARCH_URL
    delete process.env.ELASTICSEARCH_USERNAME
    delete process.env.ELASTICSEARCH_PASSWORD
    delete process.env.WAZUH_API
    delete process.env.WAZUH_USERNAME
    delete process.env.WAZUH_PASSWORD
    delete process.env.VICTORIA_METRICS_URL
  })

  afterEach(() => {
    Object.assign(process.env, originalEnv)
  })

  describe('Tool Definitions', () => {
    it('exports exactly 10 tools', () => {
      expect(securityTools).toHaveLength(10)
    })

    it('has all expected tool names', () => {
      const names = securityTools.map(t => t.name)
      const expected = [
        'crowdsec_blocks',
        'crowdsec_suggestions',
        'ntopng_threats',
        'ntopng_top_talkers',
        'elk_flow_search',
        'elk_syslog_search',
        'wazuh_alerts',
        'wazuh_rootcheck',
        'prometheus_query',
        'prometheus_query_range',
      ]
      expect(names).toEqual(expected)
    })

    it('each tool has name, description, inputSchema, and execute', () => {
      for (const tool of securityTools) {
        expect(typeof tool.name).toBe('string')
        expect(tool.description).toBeDefined()
        expect(tool.inputSchema).toBeDefined()
        expect(typeof tool.execute).toBe('function')
      }
    })

    it('crowdsec_blocks has limit parameter', () => {
      const tool = securityTools[0]
      expect(tool.inputSchema.properties.limit).toBeDefined()
      expect(tool.inputSchema.properties.limit.type).toBe('number')
    })

    it('prometheus_query requires query parameter', () => {
      const tool = securityTools[8]
      expect(tool.inputSchema.required).toContain('query')
    })

    it('prometheus_query_range requires query parameter', () => {
      const tool = securityTools[9]
      expect(tool.inputSchema.required).toContain('query')
      expect(tool.inputSchema.properties.start).toBeDefined()
      expect(tool.inputSchema.properties.end).toBeDefined()
      expect(tool.inputSchema.properties.step).toBeDefined()
    })
  })

  describe('crowdsec_blocks', () => {
    it('returns error when CROWDSEC_API is not set', async () => {
      const tool = securityTools[0]
      const result = await tool.execute({})
      expect(result).toBe('CROWDSEC_API environment variable not configured')
    })

    it('fetches from CrowdSec API when configured', async () => {
      process.env.CROWDSEC_API = 'http://localhost:8080'
      const mockRes = JSON.stringify([{ ip: '1.2.3.4' }])
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(mockRes),
      })

      const tool = securityTools[0]
      const result = await tool.execute({ limit: 10 })

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:8080/api/v1/requests/search?limit=10',
        expect.objectContaining({
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
          signal: expect.any(AbortSignal),
        }),
      )
      expect(result).toContain('1.2.3.4')
    })
  })

  describe('crowdsec_suggestions', () => {
    it('returns error when CROWDSEC_API is not set', async () => {
      const tool = securityTools[1]
      const result = await tool.execute({})
      expect(result).toBe('CROWDSEC_API environment variable not configured')
    })

    it('fetches suggestions from CrowdSec API', async () => {
      process.env.CROWDSEC_API = 'http://localhost:8080'
      const mockRes = JSON.stringify({ suggestions: ['enable something'] })
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(mockRes),
      })

      const tool = securityTools[1]
      const result = await tool.execute({})

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:8080/api/v1/suggestions',
        expect.any(Object),
      )
      expect(result).toContain('suggestions')
    })
  })

  describe('ntopng_threats', () => {
    it('returns error when NTOPNG_API is not set', async () => {
      const tool = securityTools[2]
      const result = await tool.execute({})
      expect(result).toBe('NTOPNG_API environment variable not configured')
    })

    it('fetches threats with correct URL', async () => {
      process.env.NTOPNG_API = 'http://localhost:3000'
      const mockRes = JSON.stringify({ threats: [] })
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(mockRes),
      })

      const tool = securityTools[2]
      await tool.execute({ limit: 5 })

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3000/_/api/v2/threats?active=true&limit=5',
        expect.any(Object),
      )
    })
  })

  describe('ntopng_top_talkers', () => {
    it('returns error when NTOPNG_API is not set', async () => {
      const tool = securityTools[3]
      const result = await tool.execute({})
      expect(result).toBe('NTOPNG_API environment variable not configured')
    })

    it('passes minutes parameter to API', async () => {
      process.env.NTOPNG_API = 'http://localhost:3000'
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({})),
      })

      const tool = securityTools[3]
      await tool.execute({ minutes: 120 })

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3000/_/api/v2/toptalkers?minutes=120',
        expect.any(Object),
      )
    })
  })

  describe('elk_flow_search', () => {
    it('returns error when ELASTICSEARCH_URL is not set', async () => {
      const tool = securityTools[4]
      const result = await tool.execute({})
      expect(result).toBe('ELASTICSEARCH_URL environment variable not configured')
    })

    it('uses default index flow-*', async () => {
      process.env.ELASTICSEARCH_URL = 'http://localhost:9200'
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ hits: { total: 0 } })),
      })

      const tool = securityTools[4]
      await tool.execute({})

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:9200/flow-*/_search',
        expect.objectContaining({ method: 'POST' }),
      )
    })

    it('uses custom index when provided', async () => {
      process.env.ELASTICSEARCH_URL = 'http://localhost:9200'
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({})),
      })

      const tool = securityTools[4]
      await tool.execute({ index: 'my-indices-*' })

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:9200/my-indices-*/_search',
        expect.any(Object),
      )
    })

    it('uses default size of 20', async () => {
      process.env.ELASTICSEARCH_URL = 'http://localhost:9200'
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({})),
      })

      const tool = securityTools[4]
      await tool.execute({})

      const body = JSON.parse((global.fetch as any).mock.calls[0][1].body)
      expect(body.size).toBe(20)
    })

    it('uses default match_all query', async () => {
      process.env.ELASTICSEARCH_URL = 'http://localhost:9200'
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({})),
      })

      const tool = securityTools[4]
      await tool.execute({})

      const body = JSON.parse((global.fetch as any).mock.calls[0][1].body)
      expect(body.query).toEqual({ match_all: {} })
    })

    it('uses Basic auth when credentials provided', async () => {
      process.env.ELASTICSEARCH_URL = 'http://localhost:9200'
      process.env.ELASTICSEARCH_USERNAME = 'user'
      process.env.ELASTICSEARCH_PASSWORD = 'pass'
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({})),
      })

      const tool = securityTools[4]
      await tool.execute({})

      const headers = (global.fetch as any).mock.calls[0][1].headers
      expect(headers['Authorization']).toContain('Basic ')
    })
  })

  describe('elk_syslog_search', () => {
    it('returns error when ELASTICSEARCH_URL is not set', async () => {
      const tool = securityTools[5]
      const result = await tool.execute({})
      expect(result).toBe('ELASTICSEARCH_URL environment variable not configured')
    })

    it('uses default index syslog-*', async () => {
      process.env.ELASTICSEARCH_URL = 'http://localhost:9200'
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({})),
      })

      const tool = securityTools[5]
      await tool.execute({})

      expect((global.fetch as any).mock.calls[0][0]).toContain('syslog-*/_search')
    })

    it('uses default message wildcard query', async () => {
      process.env.ELASTICSEARCH_URL = 'http://localhost:9200'
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({})),
      })

      const tool = securityTools[5]
      await tool.execute({})

      const body = JSON.parse((global.fetch as any).mock.calls[0][1].body)
      expect(body.query).toEqual({ match: { message: { query: '*' } } })
    })
  })

  describe('wazuh_alerts', () => {
    it('returns error when WAZUH_API is not set', async () => {
      const tool = securityTools[6]
      const result = await tool.execute({})
      expect(result).toBe('WAZUH_API environment variable not configured')
    })

    it('builds correct URL with default limit 50', async () => {
      process.env.WAZUH_API = 'http://localhost:55000'
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ totalResults: 0 })),
      })

      const tool = securityTools[6]
      await tool.execute({})

      const url = (global.fetch as any).mock.calls[0][0]
      expect(url).toContain('/alerts?')
      expect(url).toContain('limit=50')
      expect(url).toContain('pretty=true')
    })

    it('applies filter when provided', async () => {
      process.env.WAZUH_API = 'http://localhost:55000'
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({})),
      })

      const tool = securityTools[6]
      await tool.execute({ filter: 'rule.level>=5' })

      const url = (global.fetch as any).mock.calls[0][0]
      expect(url).toContain('filter=rule.level%3E%3D5')
    })
  })

  describe('wazuh_rootcheck', () => {
    it('returns error when WAZUH_API is not set', async () => {
      const tool = securityTools[7]
      const result = await tool.execute({})
      expect(result).toBe('WAZUH_API environment variable not configured')
    })

    it('uses default limit 20', async () => {
      process.env.WAZUH_API = 'http://localhost:55000'
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({})),
      })

      const tool = securityTools[7]
      await tool.execute({})

      const url = (global.fetch as any).mock.calls[0][0]
      expect(url).toContain('limit=20')
    })
  })

  describe('prometheus_query', () => {
    it('returns error when VICTORIA_METRICS_URL is not set', async () => {
      const tool = securityTools[8]
      const result = await tool.execute({})
      expect(result).toBe('VICTORIA_METRICS_URL environment variable not configured')
    })

    it('builds correct query URL', async () => {
      process.env.VICTORIA_METRICS_URL = 'http://localhost:8428'
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ data: { result: [] } })),
      })

      const tool = securityTools[8]
      await tool.execute({ query: 'up' })

      const url = (global.fetch as any).mock.calls[0][0]
      expect(url).toContain('/api/v1/query?query=up')
    })
  })

  describe('prometheus_query_range', () => {
    it('returns error when VICTORIA_METRICS_URL is not set', async () => {
      const tool = securityTools[9]
      const result = await tool.execute({})
      expect(result).toBe('VICTORIA_METRICS_URL environment variable not configured')
    })

    it('builds correct range query URL with default step', async () => {
      process.env.VICTORIA_METRICS_URL = 'http://localhost:8428'
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ data: { result: [] } })),
      })

      const tool = securityTools[9]
      await tool.execute({ query: 'up' })

      const url = (global.fetch as any).mock.calls[0][0]
      expect(url).toContain('/api/v1/query_range?')
      expect(url).toContain('query=up')
      expect(url).toContain('step=60s')
    })

    it('includes start, end, and step when provided', async () => {
      process.env.VICTORIA_METRICS_URL = 'http://localhost:8428'
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({})),
      })

      const tool = securityTools[9]
      await tool.execute({ query: 'up', start: '2024-01-01T00:00:00Z', end: '2024-01-02T00:00:00Z', step: '30s' })

      const url = (global.fetch as any).mock.calls[0][0]
      expect(url).toContain('start=2024-01-01T00%3A00%3A00Z')
      expect(url).toContain('end=2024-01-02T00%3A00%3A00Z')
      expect(url).toContain('step=30s')
    })
  })

  describe('Error handling', () => {
    it('crowdsec_blocks returns HTTP error from response', async () => {
      process.env.CROWDSEC_API = 'http://localhost:8080'
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      })

      const tool = securityTools[0]
      const result = await tool.execute({})
      expect(result).toContain('CrowdSec error HTTP 500')
    })

    it('ntopng_threats returns HTTP error from response', async () => {
      process.env.NTOPNG_API = 'http://localhost:3000'
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
      })

      const tool = securityTools[2]
      const result = await tool.execute({})
      expect(result).toContain('ntopng error HTTP 401')
    })

    it('elk_flow_search returns HTTP error from response', async () => {
      process.env.ELASTICSEARCH_URL = 'http://localhost:9200'
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve('Index not found'),
      })

      const tool = securityTools[4]
      const result = await tool.execute({})
      expect(result).toContain('Elasticsearch error HTTP 404')
    })

    it('prometheus_query returns HTTP error from response', async () => {
      process.env.VICTORIA_METRICS_URL = 'http://localhost:8428'
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: () => Promise.resolve('Service unavailable'),
      })

      const tool = securityTools[8]
      const result = await tool.execute({ query: 'up' })
      expect(result).toContain('VictoriaMetrics error HTTP 503')
    })
  })
})
