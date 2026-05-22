import { describe, it, expect, vi } from 'vitest'
import { buildIdOnlyFrame, type NotifyMessage } from './route'

describe('stream/route', () => {
  describe('buildIdOnlyFrame', () => {
    it('returns ID-only payload (R7 invariant)', () => {
      const frame = buildIdOnlyFrame('events', 'evt-123', 'created')
      expect(frame).toEqual<NotifyMessage>({
        channel: 'events',
        payload: { id: 'evt-123', type: 'created', timestamp: frame.payload.timestamp },
      })
      expect(frame.payload.id).toBe('evt-123')
      expect(frame.payload.type).toBe('created')
      // Ensure no row data leaks into the frame
      expect(frame.payload).not.toHaveProperty('content')
      expect(frame.payload).not.toHaveProperty('rawEvent')
      expect(frame.payload).not.toHaveProperty('attackerKey')
    })

    it('defaults type to "created"', () => {
      const frame = buildIdOnlyFrame('incidents', 'inc-456')
      expect(frame.payload.type).toBe('created')
    })

    it('supports all channel types', () => {
      const channels: NotifyMessage['channel'][] = ['events', 'incidents', 'approvals']
      for (const ch of channels) {
        const frame = buildIdOnlyFrame(ch, `id-${ch}`)
        expect(frame.channel).toBe(ch)
      }
    })

    it('supports non-created types', () => {
      const updated = buildIdOnlyFrame('events', 'evt-1', 'updated')
      expect(updated.payload.type).toBe('updated')
      const deleted = buildIdOnlyFrame('events', 'evt-2', 'deleted')
      expect(deleted.payload.type).toBe('deleted')
    })
  })

  describe('R7 invariant — frames carry no row data', () => {
    it('payload contains only id, type, timestamp', () => {
      const frame = buildIdOnlyFrame('events', 'any-id')
      expect(Object.keys(frame.payload)).toEqual(['id', 'type', 'timestamp'])
    })
  })
})
