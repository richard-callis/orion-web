import type { Environment } from '@prisma/client'

export type BootstrapEvent =
  | { type: 'step'; message: string }
  | { type: 'log'; message: string }
  | { type: 'error'; message: string }
  | { type: 'done'; message: string }

/** An Environment row as loaded by bootstrapCluster(). */
export type BootstrapEnvironment = Environment
