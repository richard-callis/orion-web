/**
 * SOC configuration seeding — runs on startup after system agents.
 *
 * Seeds default SecurityConfig entries for monitoring sources
 * and notification channels. Uses upsert so existing admin
 * edits are preserved on restart.
 */

import { prisma } from './db'

// Default source URLs for the homelab environment
const DEFAULT_SOURCES: Array<{ key: string; value: string }> = [
  { key: 'CROWDSEC_API', value: 'http://crowdsec-lapi.crowdsec:8080' },
  { key: 'NTOPNG_API', value: 'http://ntopng.monitoring:3000' },
  { key: 'ELASTICSEARCH_URL', value: 'http://elasticsearch-client.monitoring:9200' },
  { key: 'VICTORIA_METRICS_URL', value: 'http://victoria-metrics.monitoring:8428' },
  { key: 'WAZUH_API', value: 'https://wazuh-manager.security:55000' },
]

// Default notification configuration
const DEFAULT_SETTINGS: Array<{ key: string; value: string }> = [
  { key: 'socQuietHours', value: JSON.stringify({ start: '23:00', end: '07:00', enabled: false }) },
]

export async function ensureSocConfig(): Promise<void> {
  // Seed source URLs (only if env variable is set — skip if not configured)
  for (const src of DEFAULT_SOURCES) {
    const envValue = process.env[src.key as keyof typeof process.env]
    if (envValue) {
      await prisma.securityConfig.upsert({
        where: {
          environmentId_key: {
            environmentId: process.env.ENVIRONMENT_ID || '',
            key: src.key,
          },
        },
        update: {},
        create: {
          environmentId: process.env.ENVIRONMENT_ID || '',
          key: src.key,
          value: envValue,
        },
      }).catch(() => {
        // Fallback: create without environmentId
        prisma.securityConfig.upsert({
          where: {
            environmentId_key: {
              environmentId: null as unknown as string,
              key: src.key,
            },
          },
          update: {},
          create: {
            key: src.key,
            value: envValue,
          },
        })
      })
    }
  }

  // Seed system settings (quiet hours, etc.)
  for (const setting of DEFAULT_SETTINGS) {
    await prisma.systemSetting.upsert({
      where: { key: setting.key },
      update: {},
      create: { key: setting.key, value: setting.value },
    }).catch(() => {})
  }
}
