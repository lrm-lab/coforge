import {
  AGENT_SKILLS_LIST_RESULT_METHOD,
  AGENT_WORKSPACE_FILES_LIST_RESULT_METHOD,
  AGENT_WORKSPACE_FILE_READ_RESULT_METHOD,
  AGENT_WORKSPACE_DELETE_RESULT_METHOD,
  AGENT_WORKSPACE_SCAN_RESULT_METHOD,
} from "@lrm/coforge-sdk/internal";
import { createAgentSkillsListResultMethod } from "./agent-skills-cache.server";
import {
  createAgentWorkspaceFilesListResultMethod,
  createAgentWorkspaceFileReadResultMethod,
  createAgentWorkspaceDeleteResultMethod,
  createAgentWorkspaceScanResultMethod,
} from "./agent-workspace-files-cache.server";
import type { CentrifugoRpcMethod } from "./rpc-handler.server";

export function workspaceQueryResultMethods(
  enabled: boolean,
  unavailable: CentrifugoRpcMethod,
): Record<string, CentrifugoRpcMethod> {
  return {
    [AGENT_SKILLS_LIST_RESULT_METHOD]: enabled ? createAgentSkillsListResultMethod() : unavailable,
    [AGENT_WORKSPACE_FILES_LIST_RESULT_METHOD]: enabled
      ? createAgentWorkspaceFilesListResultMethod()
      : unavailable,
    [AGENT_WORKSPACE_FILE_READ_RESULT_METHOD]: enabled
      ? createAgentWorkspaceFileReadResultMethod()
      : unavailable,
    [AGENT_WORKSPACE_DELETE_RESULT_METHOD]: enabled
      ? createAgentWorkspaceDeleteResultMethod()
      : unavailable,
    [AGENT_WORKSPACE_SCAN_RESULT_METHOD]: enabled
      ? createAgentWorkspaceScanResultMethod()
      : unavailable,
  };
}
