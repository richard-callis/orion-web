import { NextResponse } from 'next/server'

// GET /api/schema — machine-readable API reference for agents
// Describes every available endpoint, method, params, and response shape
export async function GET() {
  const schema = {
    baseUrl: 'https://orion.khalisio.com',
    description: 'ORION API — use these endpoints instead of reading source files or the database directly',
    endpoints: {
      agents: {
        'GET /api/agents': {
          description: 'List all agents',
          response: 'Agent[]',
        },
        'POST /api/agents': {
          description: 'Create a new agent',
          body: { name: 'string (required)', type: 'claude|human|custom', role: 'string?', description: 'string?', metadata: 'object?' },
          response: 'Agent',
        },
        'GET /api/agents/:id': {
          description: 'Get a single agent with recent tasks and messages',
          response: 'Agent & { tasks: Task[], messages: AgentMessage[] }',
        },
        'PUT /api/agents/:id': {
          description: 'Update agent fields',
          body: { name: 'string?', role: 'string?', description: 'string?', status: 'string?', metadata: 'object?' },
          response: 'Agent',
        },
        'DELETE /api/agents/:id': {
          description: 'Delete agent (unassigns tasks first)',
          response: '204 No Content',
        },
        'POST /api/agents/spawn': {
          description: 'Create a new agent, optionally with a linked planning conversation',
          body: { name: 'string (required)', role: 'string?', type: 'string?', description: 'string?', metadata: 'object?', startConversation: 'boolean?' },
          response: '{ agent: Agent, conversation?: Conversation, streamUrl?: string }',
        },
        'POST /api/agents/:id/chat': {
          description: 'Start a chat conversation with an existing agent (agent adopts its persona/system prompt)',
          body: { title: 'string?' },
          response: '{ conversation: Conversation, streamUrl: string, hint: string }',
        },
      },
      tasks: {
        'GET /api/tasks': {
          description: 'List tasks. Supports query filters.',
          queryParams: { status: 'pending|in_progress|completed|blocked', featureId: 'string', assignedAgent: 'agentId', priority: 'low|medium|high' },
          response: 'Task[] (includes agent and feature.epic)',
        },
        'POST /api/tasks': {
          description: 'Create a task',
          body: { title: 'string (required)', description: 'string?', priority: 'low|medium|high', featureId: 'string?', assignedAgent: 'agentId?' },
          response: 'Task',
        },
        'GET /api/tasks/:id': {
          description: 'Get task with agent, feature, epic, and events',
          response: 'Task & { agent, feature.epic, events: TaskEvent[] }',
        },
        'PUT /api/tasks/:id': {
          description: 'Update task fields',
          body: { status: 'string?', title: 'string?', description: 'string?', plan: 'string?', featureId: 'string?', priority: 'string?', assignedAgent: 'agentId?' },
          response: 'Task',
        },
        'DELETE /api/tasks/:id': {
          description: 'Delete task',
          response: '204 No Content',
        },
        'POST /api/tasks/:id/events': {
          description: 'Add a comment or status event to a task. Optionally updates task status.',
          body: { eventType: 'comment|status_change|note', content: 'string?', status: 'string?' },
          response: 'TaskEvent',
        },
      },
      epics: {
        'GET /api/epics': {
          description: 'List all epics with their features',
          response: 'Epic[] (includes features with task counts)',
        },
        'POST /api/epics': {
          description: 'Create an epic',
          body: { title: 'string (required)', description: 'string?' },
          response: 'Epic',
        },
        'GET /api/epics/:id': {
          description: 'Get epic with features',
          response: 'Epic & { features: Feature[] }',
        },
        'PUT /api/epics/:id': {
          description: 'Update epic',
          body: { title: 'string?', description: 'string?', plan: 'string?', status: 'string?' },
          response: 'Epic',
        },
        'DELETE /api/epics/:id': {
          description: 'Delete epic (cascades to features and tasks)',
          response: '204 No Content',
        },
      },
      features: {
        'GET /api/features': {
          description: 'List features, optionally filtered by epic',
          queryParams: { epicId: 'string' },
          response: 'Feature[] (includes epic and task count)',
        },
        'POST /api/features': {
          description: 'Create a feature under an epic',
          body: { epicId: 'string (required)', title: 'string (required)', description: 'string?' },
          response: 'Feature',
        },
        'GET /api/features/:id': {
          description: 'Get feature with task count',
          response: 'Feature',
        },
        'PUT /api/features/:id': {
          description: 'Update feature',
          body: { title: 'string?', description: 'string?', plan: 'string?', status: 'string?' },
          response: 'Feature',
        },
        'DELETE /api/features/:id': {
          description: 'Delete feature',
          response: '204 No Content',
        },
      },
      notes: {
        'GET /api/notes': {
          description: 'List all notes',
          queryParams: { folder: 'string' },
          response: 'Note[]',
        },
        'POST /api/notes': {
          description: 'Create a note',
          body: { title: 'string (required)', content: 'string (markdown)?', folder: 'string?', pinned: 'boolean?' },
          response: 'Note',
        },
        'GET /api/notes/:id': {
          description: 'Get a single note',
          response: 'Note',
        },
        'PUT /api/notes/:id': {
          description: 'Update note',
          body: { title: 'string?', content: 'string?', folder: 'string?', pinned: 'boolean?' },
          response: 'Note',
        },
        'DELETE /api/notes/:id': {
          description: 'Delete note',
          response: '204 No Content',
        },
      },
      chat: {
        'GET /api/chat/conversations': {
          description: 'List conversations',
          response: 'Conversation[]',
        },
        'POST /api/chat/conversations': {
          description: 'Create a conversation',
          body: { title: 'string?', agentChat: '{ id, name }?', agentTarget: '{ id, name }?', agentDraft: 'boolean?' },
          response: 'Conversation',
        },
        'POST /api/chat/conversations/:id/stream': {
          description: 'Send a message and stream Claude\'s response (SSE)',
          body: { prompt: 'string (required)' },
          response: 'text/event-stream — events: { type: "text"|"done"|"error", content?: string }',
        },
      },
      infrastructure: {
        'GET /api/k8s/nodes': { description: 'List cluster nodes with status', response: 'Node[]' },
        'GET /api/k8s/pods': { description: 'List all pods across namespaces', response: 'Pod[]' },
        'GET /api/k8s/pods/:ns/:pod/logs': { description: 'Get pod logs', response: 'string' },
      },
    },
    statusValues: {
      task: ['pending', 'in_progress', 'completed', 'blocked'],
      epic: ['active', 'completed', 'archived'],
      feature: ['active', 'completed', 'archived'],
      agent: ['active', 'inactive'],
    },
    priorityValues: ['low', 'medium', 'high'],
    agentTypes: ['claude', 'human', 'custom'],
  }

  return NextResponse.json(schema)
}
