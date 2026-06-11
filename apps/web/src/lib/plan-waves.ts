export interface WaveTask {
  id: string
  dependsOn: string[]
}

/**
 * Compute the execution wave for every task in a feature.
 * Wave 0 = task with no dependencies. Wave N = 1 + the max wave of its
 * dependencies. Cycles are guarded (a task that transitively depends on
 * itself resolves to wave 0 rather than recursing forever).
 */
export function computeWaves(tasks: WaveTask[]): Map<string, number> {
  const waveMap = new Map<string, number>()
  const taskMap = new Map(tasks.map(t => [t.id, t]))

  function getWave(taskId: string, visited = new Set<string>()): number {
    const cached = waveMap.get(taskId)
    if (cached !== undefined) return cached
    if (visited.has(taskId)) return 0
    visited.add(taskId)
    const task = taskMap.get(taskId)
    const deps = (task?.dependsOn ?? []).filter(depId => taskMap.has(depId))
    if (!task || deps.length === 0) {
      waveMap.set(taskId, 0)
      return 0
    }
    const maxDepWave = Math.max(...deps.map(depId => getWave(depId, new Set(visited))))
    const wave = maxDepWave + 1
    waveMap.set(taskId, wave)
    return wave
  }

  for (const task of tasks) getWave(task.id)
  return waveMap
}
