/**
 * Worker heartbeat file, read by the orion-worker container healthcheck
 * (deploy/docker-compose.yml): fresh = the process is past startup and its
 * event loop is turning.
 *
 * It starts late on purpose. A crash loop must never look healthy between
 * crashes, so the first beat waits for a minimum uptime and for the
 * prompt-injection model to settle (loaded, failed or disabled): loading it is
 * the worker's largest memory spike, and at too low a limit the process is
 * OOM-killed there. The wait for the model is capped, so a slow first download
 * (the worker runs fine without it) doesn't keep the container unhealthy.
 */
import { writeFileSync } from 'fs'
import { err, log } from './log'

export const HEARTBEAT_FILE = process.env.ORION_WORKER_HEARTBEAT_FILE || '/tmp/orion-worker-heartbeat'
export const HEARTBEAT_INTERVAL_MS = 15_000
export const MIN_UPTIME_MS = 30_000
export const MODEL_WAIT_MS = 240_000

let timer: ReturnType<typeof setInterval> | null = null
let generation = 0
let failed = false

function beat(): void {
  try {
    writeFileSync(HEARTBEAT_FILE, `${Date.now()}\n`)
    failed = false
  } catch (e) {
    // Logged once per outage: without the file the container turns unhealthy.
    if (!failed) err(`Heartbeat write failed (${HEARTBEAT_FILE}): ${e}`)
    failed = true
  }
}

const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms).unref() })

/** Start beating once the worker is up long enough and `modelSettled` resolves (or times out). */
export async function startHeartbeatWhenReady(modelSettled: Promise<unknown>): Promise<void> {
  const mine = ++generation
  await Promise.all([
    sleep(MIN_UPTIME_MS),
    Promise.race([modelSettled.catch(() => {}), sleep(MODEL_WAIT_MS)]),
  ])
  if (mine !== generation || timer) return // stopped or restarted meanwhile
  beat()
  timer = setInterval(beat, HEARTBEAT_INTERVAL_MS)
  timer.unref()
  log('Ready — heartbeat started')
}

export function stopHeartbeat(): void {
  generation++
  if (timer) clearInterval(timer)
  timer = null
}
