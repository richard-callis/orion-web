import { describe, it, expect } from 'vitest'
import {
  notifyIncidentLinked,
  notifyStatusChanged,
  notifyMaliciousObservable,
  notifyWardenNote,
} from './notification-service'

// Notification functions depend on environment variables for delivery.
// We verify that the trigger functions resolve without throwing when
// NTFY_URL and SLACK_WEBHOOK_URL are not configured (no-op mode).

describe('notification trigger functions', () => {
  it('notifyIncidentLinked resolves without error', async () => {
    await expect(
      notifyIncidentLinked('incident-123', 'investigation-456', 'Test link'),
    ).resolves.toBeUndefined()
  })

  it('notifyStatusChanged resolves without error', async () => {
    await expect(
      notifyStatusChanged('investigation-123', 'open', 'active', 'admin'),
    ).resolves.toBeUndefined()
  })

  it('notifyMaliciousObservable resolves without error', async () => {
    await expect(
      notifyMaliciousObservable('investigation-123', 'evil.com', 'domain', 95),
    ).resolves.toBeUndefined()
  })

  it('notifyWardenNote resolves without error', async () => {
    await expect(
      notifyWardenNote('investigation-123', 'Warden analysis complete'),
    ).resolves.toBeUndefined()
  })
})
