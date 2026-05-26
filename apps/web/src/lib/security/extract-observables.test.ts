import { describe, it, expect } from 'vitest'
import {
  refang,
  isPrivateIPv4,
  isPrivateIPv6,
  isFalsePositiveHash,
  detectHashType,
  shouldSkipDomain,
  extractFromText,
  extractFromEvent,
  extractFromEvents,
  computeLinkConfidence,
  type ExtractedObservable,
} from './extract-observables'

// ── Refanging ────────────────────────────────────────────────────────────────

describe('refang', () => {
  it('converts hxxp to http', () => {
    expect(refang('hxxp://evil.com')).toBe('http://evil.com')
  })

  it('converts hxpx to http', () => {
    expect(refang('hxpx://evil.com')).toBe('http://evil.com')
  })

  it('converts [.] to dot', () => {
    expect(refang('evil[.]com')).toBe('evil.com')
  })

  it('converts [at] to @', () => {
    expect(refang('user[at]evil.com')).toBe('user@evil.com')
  })

  it('converts [::] to ::', () => {
    expect(refang('fe80[::]1')).toBe('fe80::1')
  })

  it('converts [colon] to :', () => {
    expect(refang('evil.com[colon]8080')).toBe('evil.com:8080')
  })

  it('removes whitespace', () => {
    expect(refang('e v i l')).toBe('evil')
  })

  it('handles combined defanging', () => {
    expect(refang('hxxp://evil[.]com[.]path[.]php')).toBe('http://evil.com.path.php')
  })

  it('leaves normal strings unchanged', () => {
    expect(refang('http://example.com')).toBe('http://example.com')
  })
})

// ── IP validation ────────────────────────────────────────────────────────────

describe('isPrivateIPv4', () => {
  it('identifies loopback', () => {
    expect(isPrivateIPv4('127.0.0.1')).toBe(true)
    expect(isPrivateIPv4('127.255.255.255')).toBe(true)
  })

  it('identifies 10.0.0.0/8', () => {
    expect(isPrivateIPv4('10.0.0.1')).toBe(true)
    expect(isPrivateIPv4('10.255.255.255')).toBe(true)
  })

  it('identifies 172.16.0.0/12', () => {
    expect(isPrivateIPv4('172.16.0.1')).toBe(true)
    expect(isPrivateIPv4('172.31.255.255')).toBe(true)
    expect(isPrivateIPv4('172.15.0.1')).toBe(false)
    expect(isPrivateIPv4('172.32.0.1')).toBe(false)
  })

  it('identifies 192.168.0.0/16', () => {
    expect(isPrivateIPv4('192.168.0.1')).toBe(true)
    expect(isPrivateIPv4('192.168.255.255')).toBe(true)
  })

  it('identifies link-local', () => {
    expect(isPrivateIPv4('169.254.0.1')).toBe(true)
  })

  it('identifies 0.0.0.0', () => {
    expect(isPrivateIPv4('0.0.0.0')).toBe(true)
  })

  it('allows public IPs', () => {
    expect(isPrivateIPv4('8.8.8.8')).toBe(false)
    expect(isPrivateIPv4('203.0.113.5')).toBe(false)
    expect(isPrivateIPv4('1.1.1.1')).toBe(false)
  })
})

describe('isPrivateIPv6', () => {
  it('identifies ULA', () => {
    expect(isPrivateIPv6('fc00::1')).toBe(true)
    expect(isPrivateIPv6('fd00::1')).toBe(true)
  })

  it('identifies link-local', () => {
    expect(isPrivateIPv6('fe80::1')).toBe(true)
  })

  it('identifies loopback', () => {
    expect(isPrivateIPv6('::1')).toBe(true)
  })

  it('identifies unspecified', () => {
    expect(isPrivateIPv6('::')).toBe(true)
  })

  it('allows public IPv6', () => {
    expect(isPrivateIPv6('2001:4860:4860::8888')).toBe(false)
  })
})

// ── Hash helpers ─────────────────────────────────────────────────────────────

describe('isFalsePositiveHash', () => {
  it('detects empty file MD5', () => {
    expect(isFalsePositiveHash('d41d8cd98f00b204e9800998ecf8427e')).toBe(true)
  })

  it('detects empty file SHA1', () => {
    expect(isFalsePositiveHash('da39a3ee5e6b4b0d3255bfef95601890afd80709')).toBe(true)
  })

  it('detects empty file SHA256', () => {
    expect(isFalsePositiveHash('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')).toBe(true)
  })

  it('allows real hashes', () => {
    expect(isFalsePositiveHash('098f6bcd4621d373cade4e832627b4f6')).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(isFalsePositiveHash('D41D8CD98F00B204E9800998ECF8427E')).toBe(true)
  })
})

describe('detectHashType', () => {
  it('identifies MD5 (32 hex chars)', () => {
    expect(detectHashType('098f6bcd4621d373cade4e832627b4f6')).toBe('md5')
  })

  it('identifies SHA1 (40 hex chars)', () => {
    expect(detectHashType('5baa61e4c9b93f3f0682250b6cf8331b7ee68fd8')).toBe('sha1')
  })

  it('identifies SHA256 (64 hex chars)', () => {
    expect(detectHashType('2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae')).toBe('sha256')
  })

  it('returns null for unrecognized lengths', () => {
    expect(detectHashType('abcdef')).toBe(null)
  })

  it('ignores non-hex characters when cleaning', () => {
    expect(detectHashType('098f6BCD4621d373caDE4e832627b4f6')).toBe('md5')
  })
})

// ── Domain skipping ──────────────────────────────────────────────────────────

describe('shouldSkipDomain', () => {
  it('skips .local domains', () => {
    expect(shouldSkipDomain('printer.local')).toBe(true)
  })

  it('skips .lan domains', () => {
    expect(shouldSkipDomain('host.lan')).toBe(true)
  })

  it('skips .home.arpa domains', () => {
    expect(shouldSkipDomain('device.home.arpa')).toBe(true)
  })

  it('skips localhost', () => {
    expect(shouldSkipDomain('localhost')).toBe(true)
  })

  it('allows public domains', () => {
    expect(shouldSkipDomain('evil.com')).toBe(false)
    expect(shouldSkipDomain('attacker.org')).toBe(false)
  })

  it('respects custom suffixes', () => {
    expect(shouldSkipDomain('internal.corp', { skipDomainSuffixes: ['corp', 'internal'] })).toBe(true)
    expect(shouldSkipDomain('evil.com', { skipDomainSuffixes: ['corp', 'internal'] })).toBe(false)
  })
})

// ── Text extraction ──────────────────────────────────────────────────────────

describe('extractFromText', () => {
  it('extracts IPv4 addresses', () => {
    const result = extractFromText('Connection from 203.0.113.5 to 198.51.100.1')
    expect(result).toHaveLength(2)
    expect(result.find(o => o.value === '203.0.113.5')).toBeDefined()
    expect(result.find(o => o.value === '198.51.100.1')).toBeDefined()
  })

  it('skips private IPv4 by default', () => {
    const result = extractFromText('Connection from 192.168.1.1 to 10.0.0.1')
    const ips = result.filter(o => o.category === 'ipv4')
    expect(ips).toHaveLength(0)
  })

  it('includes private IPs when allowlisted', () => {
    const result = extractFromText('Connection from 192.168.1.1', {
      allowList: ['192.168.1.1'],
    })
    expect(result.find(o => o.value === '192.168.1.1')).toBeDefined()
  })

  it('excludes denied IPs', () => {
    const result = extractFromText('Connection from 203.0.113.5', {
      denyList: ['203.0.113.5'],
    })
    const ips = result.filter(o => o.category === 'ipv4')
    expect(ips).toHaveLength(0)
  })

  it('extracts domains', () => {
    const result = extractFromText('Query for evil.com and malware.org')
    const domains = result.filter(o => o.category === 'domain')
    expect(domains).toHaveLength(2)
  })

  it('skips local domains', () => {
    const result = extractFromText('Query for printer.local and host.lan')
    const domains = result.filter(o => o.category === 'domain')
    expect(domains).toHaveLength(0)
  })

  it('extracts URLs', () => {
    const result = extractFromText('Visit http://evil.com/path and https://malware.org/c2')
    const urls = result.filter(o => o.category === 'url')
    expect(urls).toHaveLength(2)
    expect(urls[0].value).toBe('http://evil.com/path')
  })

  it('extracts domain from URL', () => {
    const result = extractFromText('Visit http://evil.com/path')
    const domains = result.filter(o => o.category === 'domain')
    expect(domains.find(o => o.value === 'evil.com')).toBeDefined()
  })

  it('extracts MD5 hashes', () => {
    const result = extractFromText('File hash: 098f6bcd4621d373cade4e832627b4f6')
    const hashes = result.filter(o => o.category === 'file_hash_md5')
    expect(hashes).toHaveLength(1)
    expect(hashes[0].confidence).toBe(85)
  })

  it('extracts SHA256 hashes', () => {
    const result = extractFromText(
      'SHA256: 2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae',
    )
    const hashes = result.filter(o => o.category === 'file_hash_sha256')
    expect(hashes).toHaveLength(1)
    expect(hashes[0].confidence).toBe(95)
  })

  it('skips empty file hashes', () => {
    const result = extractFromText('d41d8cd98f00b204e9800998ecf8427e')
    const hashes = result.filter(o => o.category.startsWith('file_hash'))
    expect(hashes).toHaveLength(0)
  })

  it('extracts MAC addresses', () => {
    const result = extractFromText('MAC: aa:bb:cc:dd:ee:ff detected on port')
    const macs = result.filter(o => o.category === 'mac_address')
    expect(macs).toHaveLength(1)
    expect(macs[0].value).toBe('aa:bb:cc:dd:ee:ff')
  })

  it('extracts emails', () => {
    const result = extractFromText('Contact admin@evil.com for more info')
    const emails = result.filter(o => o.category === 'email')
    expect(emails).toHaveLength(1)
    expect(emails[0].value).toBe('admin@evil.com')
  })

  it('refangs observables', () => {
    const result = extractFromText('Visit hxxp://evil[.]com[.]path')
    const urls = result.filter(o => o.category === 'url')
    expect(urls[0].value).toBe('http://evil.com.path')
    expect(urls[0].displayValue).toBe('hxxp://evil[.]com[.]path')
  })

  it('deduplicates identical observables', () => {
    const result = extractFromText('IP 203.0.113.5 and again 203.0.113.5')
    const ips = result.filter(o => o.category === 'ipv4')
    expect(ips).toHaveLength(1)
  })

  it('handles empty input', () => {
    const result = extractFromText('')
    expect(result).toHaveLength(0)
  })

  it('handles input with no observables', () => {
    const result = extractFromText('This is just normal text with nothing interesting')
    expect(result.filter(o => o.category !== 'domain')).toHaveLength(0)
  })
})

// ── Per-source extraction ────────────────────────────────────────────────────

describe('extractFromEvent', () => {
  it('extracts IP from CrowdSec event', () => {
    const result = extractFromEvent('crowdsec', {
      payload: { value: '203.0.113.5' },
      reason: 'SSH brute force',
    })
    expect(result.find(o => o.value === '203.0.113.5' && o.category === 'ipv4')).toBeDefined()
  })

  it('extracts from Falco event fields', () => {
    const result = extractFromEvent('falco', {
      fields: { fd: { sip: '203.0.113.5', cip: '198.51.100.1' } },
      output: 'Forbidden connection to 203.0.113.5',
    })
    const ips = result.filter(o => o.category === 'ipv4')
    expect(ips).toHaveLength(2)
  })

  it('extracts from ntopng event', () => {
    const result = extractFromEvent('ntopng', {
      cli_ip: '203.0.113.5',
      srv_ip: '198.51.100.1',
      info: 'DNS query for evil.com',
    })
    expect(result.find(o => o.value === 'evil.com' && o.category === 'domain')).toBeDefined()
  })

  it('extracts from ELK event', () => {
    const result = extractFromEvent('elk', {
      source: { ip: '203.0.113.5' },
      destination: { ip: '198.51.100.1' },
      dns: { question: { name: 'evil.com' } },
      url: { original: 'http://evil.com/path' },
    })
    const categories = new Set(result.map(o => o.category))
    expect(categories.has('ipv4')).toBe(true)
    expect(categories.has('domain')).toBe(true)
    expect(categories.has('url')).toBe(true)
  })

  it('extracts MAC from UniFi event', () => {
    const result = extractFromEvent('unifi', {
      src_ip: '203.0.113.5',
      mac: 'aa:bb:cc:dd:ee:ff',
      hostname: 'new-device',
    })
    expect(result.find(o => o.category === 'mac_address')).toBeDefined()
  })

  it('extracts from Suricata event', () => {
    const result = extractFromEvent('suricata', {
      src_ip: '203.0.113.5',
      alert: { signature: 'ET MALWARE C2 Callback' },
      dns: { rrname: 'evil.com' },
      http: { hostname: 'c2.evil.com', uri: '/beacon' },
    })
    const categories = new Set(result.map(o => o.category))
    expect(categories.has('ipv4')).toBe(true)
    expect(categories.has('domain')).toBe(true)
  })

  it('falls back to default field scanning for unknown source', () => {
    const result = extractFromEvent('unknown_source', {
      suspicious_ip: '203.0.113.5',
      domain: 'evil.com',
    })
    expect(result.find(o => o.value === '203.0.113.5')).toBeDefined()
    expect(result.find(o => o.value === 'evil.com' && o.category === 'domain')).toBeDefined()
  })
})

// ── Batch extraction ─────────────────────────────────────────────────────────

describe('extractFromEvents', () => {
  it('deduplicates across events', () => {
    const result = extractFromEvents([
      { source: 'crowdsec', rawEvent: { payload: { value: '203.0.113.5' } } },
      { source: 'suricata', rawEvent: { src_ip: '203.0.113.5' } },
    ])
    const ips = result.filter(o => o.value === '203.0.113.5')
    expect(ips).toHaveLength(1)
  })

  it('takes highest confidence', () => {
    const result = extractFromEvents([
      { source: 'elk', rawEvent: { source: { ip: '203.0.113.5' } } },
      { source: 'suricata', rawEvent: { src_ip: '203.0.113.5', alert: { signature: 'ET MALWARE' } } },
    ])
    const ip = result.find(o => o.value === '203.0.113.5')
    expect(ip).toBeDefined()
  })

  it('handles empty event list', () => {
    const result = extractFromEvents([])
    expect(result).toHaveLength(0)
  })
})

// ── Auto-linking confidence ──────────────────────────────────────────────────

describe('computeLinkConfidence', () => {
  const existingObservables: ExtractedObservable[] = [
    { value: '203.0.113.5', displayValue: '203.0.113.5', category: 'ipv4', confidence: 60 },
    { value: 'evil.com', displayValue: 'evil.com', category: 'domain', confidence: 65 },
    { value: '2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae', displayValue: '2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae', category: 'file_hash_sha256', confidence: 95 },
  ]

  it('auto-links on hash match', () => {
    const newObs: ExtractedObservable[] = [
      { value: '2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae', displayValue: '2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae', category: 'file_hash_sha256', confidence: 95 },
    ]
    const result = computeLinkConfidence(newObs, existingObservables, new Date(Date.now() - 48 * 3600000))
    expect(result).not.toBeNull()
    expect(result!.action).toBe('auto')
    expect(result!.confidence).toBe(95)
  })

  it('never auto-links on IP alone', () => {
    const newObs: ExtractedObservable[] = [
      { value: '203.0.113.5', displayValue: '203.0.113.5', category: 'ipv4', confidence: 60 },
    ]
    const result = computeLinkConfidence(newObs, existingObservables, new Date(Date.now() - 3600000))
    expect(result).not.toBeNull()
    expect(result!.action).toBe('suggestion')
  })

  it('suggests on domain match within 24h', () => {
    const newObs: ExtractedObservable[] = [
      { value: 'evil.com', displayValue: 'evil.com', category: 'domain', confidence: 65 },
    ]
    const result = computeLinkConfidence(newObs, existingObservables, new Date(Date.now() - 12 * 3600000))
    expect(result).not.toBeNull()
    expect(result!.action).toBe('suggestion')
  })

  it('auto-links on 2+ medium matches', () => {
    const newObs: ExtractedObservable[] = [
      { value: 'evil.com', displayValue: 'evil.com', category: 'domain', confidence: 65 },
      { value: '203.0.113.5', displayValue: '203.0.113.5', category: 'ipv4', confidence: 60 },
    ]
    const result = computeLinkConfidence(newObs, existingObservables, new Date(Date.now() - 12 * 3600000))
    expect(result).not.toBeNull()
    expect(result!.action).toBe('auto')
  })

  it('returns null for no matches', () => {
    const newObs: ExtractedObservable[] = [
      { value: '1.2.3.4', displayValue: '1.2.3.4', category: 'ipv4', confidence: 60 },
    ]
    const result = computeLinkConfidence(newObs, existingObservables, new Date())
    expect(result).toBeNull()
  })

  it('returns null for empty inputs', () => {
    const result = computeLinkConfidence([], [], new Date())
    expect(result).toBeNull()
  })
})
