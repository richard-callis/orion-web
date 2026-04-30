export interface Agent {
  id: string
  name: string
  type: string
  role: string | null
  description: string | null
  status: string
  metadata: Record<string, unknown> | null
}

export interface TaskUser {
  id: string
  name: string | null
  username: string
  email: string
  role: string
}

export interface Task {
  id: string
  title: string
  description: string | null
  plan: string | null
  status: string
  priority: string
  featureId: string | null
  assignedAgent: string | null
  agent: Agent | null
  assignedUserId: string | null
  assignedUser: TaskUser | null
  createdAt: string
  updatedAt: string
}

export interface Feature {
  id: string
  epicId: string
  title: string
  description: string | null
  plan: string | null
  status: string
  createdAt: string
  updatedAt: string
  _count?: { tasks: number }
}

export interface Epic {
  id: string
  title: string
  description: string | null
  plan: string | null
  status: string
  createdAt: string
  updatedAt: string
  features: Feature[]
}

export type SelectionState =
  | { kind: 'all' }
  | { kind: 'epic';    epicId: string }
  | { kind: 'feature'; epicId: string; featureId: string }
  | { kind: 'unassigned' }

export interface Bug {
  id: string
  title: string
  description: string | null
  severity: string
  status: string
  area: string | null
  reportedBy: string
  assignedUserId: string | null
  assignedUser: TaskUser | null
  createdAt: string
  updatedAt: string
}

export interface EpicContext {
  epicTitle: string
  epicDescription: string | null
  epicPlan: string | null
}

export interface FeatureContext extends EpicContext {
  featureTitle: string
  featureDescription: string | null
  featurePlan: string | null
}

export type PlanTarget =
  | { type: 'task';    id: string; title: string; description: string | null; parentContext?: FeatureContext }
  | { type: 'feature'; id: string; title: string; description: string | null; parentContext?: EpicContext }
  | { type: 'epic';    id: string; title: string; description: string | null }
