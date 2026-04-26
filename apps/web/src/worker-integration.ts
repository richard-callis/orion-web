/**
 * Integration point for background worker tasks
 *
 * Call this from your worker.ts main loop to ensure maintenance runs daily
 *
 * SOC2 #AUDIT-001: Ensures audit logs are automatically cleaned per policy
 */

import { runMaintenanceTasks } from './lib/worker-tasks'

let lastMaintenanceRun = 0
const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24 hours

export async function checkAndRunMaintenance(): Promise<void> {
  const now = Date.now()

  if (now - lastMaintenanceRun < MAINTENANCE_INTERVAL_MS) {
    return // Not yet time
  }

  lastMaintenanceRun = now

  console.log('[worker] Running maintenance tasks...')
  const result = await runMaintenanceTasks()

  if (!result.success) {
    console.warn('[worker] Maintenance completed with errors:', result.errors)
  } else {
    console.log('[worker] Maintenance completed successfully')
  }
}

/**
 * Call this in your worker's main loop:
 *
 * async function pollOnce() {
 *   await checkAndRunMaintenance()  // Add this line
 *   // ... rest of worker logic
 * }
 */
