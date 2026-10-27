import { useCallback } from "react";
import { useServerFn } from "@tanstack/react-start";

import { listAgentReminders } from "#src/features/agents/agent-reminders.functions";
import { getAgentSkills } from "#src/features/agents/agent-skills.functions";
import {
  listAgentWorkspaceFiles,
  readAgentWorkspaceFile,
} from "#src/features/agents/agent-workspace-files.functions";

/** The lazy reads the panel hands its Reminders, Profile (skills) and Workspace tabs. */
export function useAgentPanelLoaders(agentId: string) {
  const loadReminders = useServerFn(listAgentReminders);
  const onLoadReminders = useCallback(
    (cursor?: { id: string }) =>
      loadReminders({ data: { agentId, ...(cursor ? { cursor } : {}) } }),
    [agentId, loadReminders],
  );

  const loadSkills = useServerFn(getAgentSkills);
  const onLoadSkills = useCallback(() => loadSkills({ data: agentId }), [agentId, loadSkills]);

  const listWorkspaceFiles = useServerFn(listAgentWorkspaceFiles);
  const onListWorkspaceDir = useCallback(
    (dirPath: string, includeHidden: boolean) =>
      listWorkspaceFiles({ data: { agentId, dirPath, includeHidden } }),
    [agentId, listWorkspaceFiles],
  );
  const readWorkspaceFile = useServerFn(readAgentWorkspaceFile);
  const onReadWorkspaceFile = useCallback(
    (path: string) => readWorkspaceFile({ data: { agentId, path } }),
    [agentId, readWorkspaceFile],
  );

  return { onLoadReminders, onLoadSkills, onListWorkspaceDir, onReadWorkspaceFile };
}
