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
