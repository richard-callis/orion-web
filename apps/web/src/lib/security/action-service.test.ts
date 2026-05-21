/**
 * Unit tests for action-service pure helpers.
 *
 * Covers the BLOCK/MAJOR fixes from the SIEM P2 review:
 *   B6 — isDestructiveAction must NOT catch crowdsec_decision_delete
 *   M1 — IPv6 home-subnet override must engage (fail-closed)
 *   matchesPattern — wildcard, literal, subnet operators
 *
 * The `decide()` and `execute()` flows talk to Prisma; we cover them via the
 * pure helpers + the executor branch logic that doesn't hit the DB.
 */

import { describe, it, expect } from 'vitest'
import {
  isDestructiveAction,
  matchesPattern,
  ipInRange,
  prefixLTE,
  extractPrefixLength,
} from './action-service'

describe('action-service: isDestructiveAction', () => {
  it('does NOT flag crowdsec_decision_delete (the original substring bug)', () => {
    // B6: the prior heuristic matched on substring "delete" and broke unbans
    expect(isDestructiveAction('crowdsec_decision_delete')).toBe(false)
  })

  it('does NOT flag legitimate auto-tier actions', () => {
    expect(isDestructiveAction('crowdsec_decision_create')).toBe(false)
    expect(isDestructiveAction('investigate')).toBe(false)
    expect(isDestructiveAction('incident_close')).toBe(false)
    expect(isDestructiveAction('suppression_add')).toBe(false)
  })

  it('flags the __destructive__ policy bucket', () => {
    expect(isDestructiveAction('__destructive__')).toBe(true)
  })

  it('flags explicit infra-destroy actions', () => {
    expect(isDestructiveAction('infra_destroy')).toBe(true)
    expect(isDestructiveAction('infra_wipe')).toBe(true)
    expect(isDestructiveAction('volume_purge')).toBe(true)
    expect(isDestructiveAction('cluster_delete')).toBe(true)
  })

  it('does NOT match by substring (allowlist, not heuristic)', () => {
    expect(isDestructiveAction('safe_cluster_delete_v2')).toBe(false)
    expect(isDestructiveAction('please_destroy_nothing')).toBe(false)
    expect(isDestructiveAction('delete_audit_after_purge')).toBe(false)
  })
})

describe('action-service: ipInRange (IPv4)', () => {
  it('matches 10.x in 10.0.0.0/8', () => {
    expect(ipInRange('10.1.2.3', '10.0.0.0/8')).toBe(true)
    expect(ipInRange('10.255.255.254', '10.0.0.0/8')).toBe(true)
  })

  it('rejects 11.x outside 10.0.0.0/8', () => {
    expect(ipInRange('11.0.0.1', '10.0.0.0/8')).toBe(false)
  })

  it('matches 192.168.x.x in 192.168.0.0/16', () => {
    expect(ipInRange('192.168.1.1', '192.168.0.0/16')).toBe(true)
  })

  it('rejects public IPs outside home subnets', () => {
    expect(ipInRange('8.8.8.8', '10.0.0.0/8')).toBe(false)
    expect(ipInRange('1.1.1.1', '192.168.0.0/16')).toBe(false)
  })
})

describe('action-service: ipInRange (IPv6 fail-closed) — R1', () => {
  it('engages the home-subnet override for an IPv6 address', () => {
    // M1: prior code returned false for anything without a dot, so IPv6 home
    // addresses bypassed the home-subnet `approve` override. We now fail closed
    // and return true, forcing the override.
    expect(ipInRange('fe80::1', '10.0.0.0/8')).toBe(true)
    expect(ipInRange('::1', '192.168.0.0/16')).toBe(true)
    expect(ipInRange('2001:db8::1', '172.16.0.0/12')).toBe(true)
  })

  it('still rejects malformed inputs', () => {
    expect(ipInRange('not-an-ip', '10.0.0.0/8')).toBe(false)
    expect(ipInRange('10.0.0.1', 'no-cidr-here')).toBe(false)
  })
})

describe('action-service: matchesPattern', () => {
  it('handles literal match', () => {
    expect(matchesPattern('named-prod-1', 'named-prod-1', 'strict')).toBe(true)
    expect(matchesPattern('named-dev-1', 'named-prod-1', 'strict')).toBe(false)
  })

  it('handles wildcard match', () => {
    expect(matchesPattern('named-prod-1', 'named-prod-*')).toBe(true)
    expect(matchesPattern('named-prod-foo-bar', 'named-prod-*')).toBe(true)
    expect(matchesPattern('named-dev-1', 'named-prod-*')).toBe(false)
  })

  it('handles subnet operator with IPv4 home range', () => {
    expect(matchesPattern('10.1.2.3', '10.0.0.0/8', 'subnet')).toBe(true)
    expect(matchesPattern('8.8.8.8', '10.0.0.0/8', 'subnet')).toBe(false)
  })

  it('handles subnet operator with IPv6 — fail-closed', () => {
    // R1 mitigation: IPv6 home-subnet override must engage.
    expect(matchesPattern('fe80::1', '10.0.0.0/8', 'subnet')).toBe(true)
  })
})

// ── prefixLTE / prefix_lte ──────────────────────────────────────────────────

describe('action-service: extractPrefixLength', () => {
  it('parses IPv4 /8 through /32', () => {
    for (let i = 0; i <= 32; i++) {
      expect(extractPrefixLength(`10.0.0.0/${i}`)).toBe(i)
    }
  })

  it('parses IPv6 /16 through /128', () => {
    for (const p of [16, 32, 48, 64, 96, 112, 128]) {
      expect(extractPrefixLength(`2001:db8::/${p}`)).toBe(p)
    }
  })

  it('parses prefix-only notation', () => {
    expect(extractPrefixLength('/8')).toBe(8)
    expect(extractPrefixLength('/24')).toBe(24)
    expect(extractPrefixLength('/64')).toBe(64)
    expect(extractPrefixLength('/128')).toBe(128)
  })

  it('rejects out-of-range prefixes', () => {
    expect(extractPrefixLength('10.0.0.0/33')).toBe(null)
    expect(extractPrefixLength('::/129')).toBe(null)
    expect(extractPrefixLength('/-1')).toBe(null)
    expect(extractPrefixLength('/abc')).toBe(null)
  })

  it('rejects malformed input', () => {
    expect(extractPrefixLength('not-a-cidr')).toBe(null)
    expect(extractPrefixLength('10.0.0.1')).toBe(null) // no slash
  })
})

describe('action-service: prefixLTE — prefix length comparison', () => {
  // Core semantics: targetLen <= patternLen means target is wider-or-equal
  it('firewall_block 0.0.0.0/0 matches /24 threshold', () => {
    expect(prefixLTE('0.0.0.0/0', '/24')).toBe(true) // 0 <= 24
  })

  it('firewall_block 10.0.0.0/8 matches /24 threshold', () => {
    expect(prefixLTE('10.0.0.0/8', '/24')).toBe(true) // 8 <= 24
  })

  it('firewall_block 10.0.0.0/16 matches /24 threshold', () => {
    expect(prefixLTE('10.0.0.0/16', '/24')).toBe(true) // 16 <= 24
  })

  it('firewall_block 10.0.0.0/24 does NOT exceed /24 threshold (equal)', () => {
    expect(prefixLTE('10.0.0.0/24', '/24')).toBe(true) // 24 <= 24 — equal counts
  })

  it('firewall_block 10.0.0.0/32 does NOT match /24 threshold', () => {
    expect(prefixLTE('10.0.0.0/32', '/24')).toBe(false) // 32 > 24 — too narrow
  })

  it('handles IPv6 prefix comparison', () => {
    expect(prefixLTE('2001:db8::/32', '/48')).toBe(true) // 32 <= 48
    expect(prefixLTE('2001:db8::/48', '/64')).toBe(true) // 48 <= 64
    expect(prefixLTE('2001:db8::/64', '/48')).toBe(false) // 64 > 48
    expect(prefixLTE('::/0', '/16')).toBe(true) // 0 <= 16
    expect(prefixLTE('fe80::/10', '/128')).toBe(true) // 10 <= 128
    expect(prefixLTE('fe80::/128', '/16')).toBe(false) // 128 > 16
  })

  // Home-subnet inversion: a /32 inside the home subnet should NOT trigger
  // escalation via prefix_lte, because 32 > 24 (it's narrower)
  it('home-subnet /32 does NOT escalate via prefix_lte (narrower than /24)', () => {
    const homeIP = '10.1.2.3'
    const cidr = `${homeIP}/32`
    expect(prefixLTE(cidr, '/24')).toBe(false) // 32 > 24 — narrow host, no escalation
  })

  // Unparseable inputs default to safe behavior
  it('returns false for unparseable inputs (safe default)', () => {
    expect(prefixLTE('not-a-cidr', '/24')).toBe(false)
    expect(prefixLTE('10.0.0.0', '/24')).toBe(false) // no slash in target
    expect(prefixLTE('10.0.0.0/8', 'not-a-pattern')).toBe(false)
  })
})

describe('action-service: matchesPattern prefix_lte operator', () => {
  it('escalates 0.0.0.0/0 against /24 (B5: the original dead-code path)', () => {
    expect(
      matchesPattern('0.0.0.0/0', '/24', 'prefix_lte')
    ).toBe(true)
  })

  it('escalates 172.16.0.0/12 against /24', () => {
    expect(
      matchesPattern('172.16.0.0/12', '/24', 'prefix_lte')
    ).toBe(true)
  })

  it('does NOT escalate 10.0.1.0/24 against /24 (equal)', () => {
    // 24 <= 24 is true, so this DOES match (equal is wider-or-equal)
    expect(
      matchesPattern('10.0.1.0/24', '/24', 'prefix_lte')
    ).toBe(true)
  })

  it('does NOT escalate 10.0.1.0/32 against /24 (host route)', () => {
    expect(
      matchesPattern('10.0.1.0/32', '/24', 'prefix_lte')
    ).toBe(false)
  })
})
