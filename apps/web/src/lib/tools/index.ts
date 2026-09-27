/**
 * Registers every built-in ORION management tool, in the canonical order.
 *
 * Order matters: it is the order tools are listed to models and in the UI.
 * The tool-registry characterization test pins it.
 */

import { registerTool, type ToolDefinition } from './registry'
import { orionListAgentsTool, orionCreateAgentTool, orionUpdateAgentTool, orionArchiveAgentTool, spawnAgentTool, findSpecialistTool } from './agents'
import { orionListTasksTool, orionAssignTaskTool, orionEscalateTaskTool, orionGetTaskEventsTool, orionCloseTaskTool, orionReopenTaskTool, orionCreateFeatureTool, orionCreateTaskTool } from './tasks'
import { orionListRoomsTool, orionSendMessageTool, orionSetGoalTool, orionCompleteGoalTool } from './rooms'
import { gitopsLsTool, getClusterApiResourcesTool, validateManifestTool, gitopsProposeTool, giteaMergePrTool, giteaClosePrTool, listDeploymentTemplatesTool, getDeploymentTemplateTool } from './gitops'
import { orionClusterHealthTool } from './cluster-health'
import { orionGetEnvironmentTool, orionPatchEnvironmentTool, orionBootstrapEnvironmentTool } from './environment'
import { orionRequestToolGrantTool, listToolGroupsTool, listAgentGroupsTool, manageToolGroupAccessTool, manageAgentGroupMembershipTool } from './access'
import { proposeToolTool, listToolsTool, describeToolTool } from './discovery'
import { knowledgeRememberTool, knowledgeSearchTool, knowledgeLoadContextTool, knowledgeGraphTool, knowledgeWriteTool } from './knowledge'
import { orionListSecretsTool, generateSecretTool } from './secrets'
import { approveExecutionTool, denyExecutionTool } from './executions'
import { securityProposeActionTool, investigationSearchTool, investigationCreateTool, investigationReadTool, investigationNoteTool, investigationUpdateTool, investigationLinkIncidentTool, observableAddTool, observableSetVerdictTool, timelineAddTool } from './security'

export const BUILTIN_TOOLS: readonly ToolDefinition[] = [
  gitopsLsTool,
  orionListAgentsTool,
  orionListTasksTool,
  orionAssignTaskTool,
  orionCreateAgentTool,
  orionUpdateAgentTool,
  orionArchiveAgentTool,
  orionEscalateTaskTool,
  orionGetTaskEventsTool,
  orionCloseTaskTool,
  orionReopenTaskTool,
  orionListRoomsTool,
  orionSendMessageTool,
  orionSetGoalTool,
  orionCompleteGoalTool,
  orionCreateFeatureTool,
  orionCreateTaskTool,
  getClusterApiResourcesTool,
  validateManifestTool,
  orionClusterHealthTool,
  orionRequestToolGrantTool,
  orionGetEnvironmentTool,
  orionPatchEnvironmentTool,
  knowledgeRememberTool,
  orionBootstrapEnvironmentTool,
  spawnAgentTool,
  gitopsProposeTool,
  giteaMergePrTool,
  giteaClosePrTool,
  proposeToolTool,
  listToolGroupsTool,
  listAgentGroupsTool,
  manageToolGroupAccessTool,
  manageAgentGroupMembershipTool,
  knowledgeSearchTool,
  knowledgeLoadContextTool,
  knowledgeGraphTool,
  knowledgeWriteTool,
  orionListSecretsTool,
  generateSecretTool,
  listDeploymentTemplatesTool,
  getDeploymentTemplateTool,
  findSpecialistTool,
  listToolsTool,
  describeToolTool,
  approveExecutionTool,
  denyExecutionTool,
  securityProposeActionTool,
  investigationSearchTool,
  investigationCreateTool,
  investigationReadTool,
  investigationNoteTool,
  investigationUpdateTool,
  investigationLinkIncidentTool,
  observableAddTool,
  observableSetVerdictTool,
  timelineAddTool,
]

for (const def of BUILTIN_TOOLS) registerTool(def)
