import type { TaskRunContext } from './types'
import { getPrompt, interpolate } from '@/lib/system-prompts'

/** The user turn that starts a task run (shared by every runner). */
export async function buildTaskPrompt(ctx: TaskRunContext): Promise<string> {
  const template = await getPrompt('system.task-execution')
  return interpolate(template, {
    taskTitle:       ctx.taskTitle,
    taskDescription: ctx.taskDescription ? `Description: ${ctx.taskDescription}` : '',
    taskPlan:        ctx.taskPlan ? `\nImplementation plan:\n${ctx.taskPlan}` : '',
  })
}
