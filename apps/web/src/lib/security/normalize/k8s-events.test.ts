import { describe, it, expect } from 'vitest'
import { normalizeK8sEvent, type K8sEvent } from './k8s-events'

const baseEvent: K8sEvent = {
  metadata: {
    uid: 'event-uid-1',
    name: 'pod-x.000',
    namespace: 'default',
    resourceVersion: '12345',
  },
  reason: 'CrashLoopBackOff',
  message: 'Back-off 5m0s restarting failed container',
  type: 'Warning',
  count: 3,
  lastTimestamp: '2026-05-22T14:00:00Z',
  involvedObject: { kind: 'Pod', name: 'orion-gateway-abc', namespace: 'default' },
}

describe('normalizeK8sEvent', () => {
  it('maps known reasons to spec severity', () => {
    expect(normalizeK8sEvent({ ...baseEvent, reason: 'CrashLoopBackOff' }, 'env_1').severity).toBe(60)
    expect(normalizeK8sEvent({ ...baseEvent, reason: 'OOMKilled' }, 'env_1').severity).toBe(65)
    expect(normalizeK8sEvent({ ...baseEvent, reason: 'ImagePullBackOff' }, 'env_1').severity).toBe(30)
    expect(normalizeK8sEvent({ ...baseEvent, reason: 'Evicted' }, 'env_1').severity).toBe(50)
  })

  it('applies +15 namespace bump for kube-system', () => {
    const ev = normalizeK8sEvent(
      {
        ...baseEvent,
        reason: 'CrashLoopBackOff',
        metadata: { ...baseEvent.metadata, namespace: 'kube-system' },
        involvedObject: { ...baseEvent.involvedObject, namespace: 'kube-system' },
      },
      'env_1'
    )
    expect(ev.severity).toBe(75) // 60 + 15
  })

  it('clamps severity at 100', () => {
    const ev = normalizeK8sEvent(
      {
        ...baseEvent,
        reason: 'PolicyViolation',
        metadata: { ...baseEvent.metadata, namespace: 'kube-system' },
      },
      'env_1'
    )
    expect(ev.severity).toBeLessThanOrEqual(100)
  })

  it('defaults unknown reasons to 25', () => {
    const ev = normalizeK8sEvent({ ...baseEvent, reason: 'SomeNewReason' }, 'env_1')
    expect(ev.severity).toBe(25)
    expect(ev.type).toBe('k8s.somenewreason')
  })

  it('dedupKey is sha256(envId|uid|count) — sensitive to all three', () => {
    const a = normalizeK8sEvent(baseEvent, 'env_1').dedupKey
    const b = normalizeK8sEvent(baseEvent, 'env_2').dedupKey
    const c = normalizeK8sEvent({ ...baseEvent, count: 4 }, 'env_1').dedupKey
    const d = normalizeK8sEvent(
      { ...baseEvent, metadata: { ...baseEvent.metadata, uid: 'event-uid-2' } },
      'env_1'
    ).dedupKey
    expect(new Set([a, b, c, d]).size).toBe(4)
  })

  it('handles missing count by defaulting to 1', () => {
    const { count: _omitted, ...rest } = baseEvent
    const ev = normalizeK8sEvent(rest as K8sEvent, 'env_1')
    expect((ev.metadata as any).count).toBe(1)
  })

  it('title includes involvedObject and namespace', () => {
    const ev = normalizeK8sEvent(baseEvent, 'env_1')
    expect(ev.title).toContain('Pod/orion-gateway-abc')
    expect(ev.title).toContain('(default)')
  })

  it('falls back to firstTimestamp when lastTimestamp is missing', () => {
    const { lastTimestamp: _omitted, ...rest } = baseEvent
    const ev = normalizeK8sEvent(
      { ...rest, firstTimestamp: '2026-05-22T13:00:00Z' } as K8sEvent,
      'env_1'
    )
    expect(ev.timestamp?.toISOString()).toBe('2026-05-22T13:00:00.000Z')
  })

  it('always sets source to k8s_events', () => {
    expect(normalizeK8sEvent(baseEvent, 'env_1').source).toBe('k8s_events')
  })
})
