import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { CACHE_REGISTRY } from '@/lib/system-cache'
import { SettingsForm } from './SettingsForm'
import { saveSettings, flushCaches } from './actions'

export default async function SettingsPage() {
  await requireAdmin()

  const [rows, models] = await Promise.all([
    prisma.systemSetting.findMany(),
    prisma.externalModel.findMany({ where: { enabled: true }, orderBy: { name: 'asc' } }),
  ])

  const settings = Object.fromEntries(rows.map(r => [r.key, r.value]))

  return (
    <SettingsForm
      initialSettings={settings}
      externalModels={models}
      cacheRegistry={[...CACHE_REGISTRY]}
      saveSettings={saveSettings}
      flushCaches={flushCaches}
    />
  )
}
