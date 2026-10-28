import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";

import { agentModelsQuery, type AgentModels } from "./agent-models";
import { useCurrentWorkspaceId } from "./workspace-agents-realtime";

/**
 * An Agent's model by the name the chat label uses (`listVisibleAgentModels`, which resolves it
 * against the Computer's catalog), for the profile, its hover card and the Computer's Agent list.
 * `undefined` while the Workspace's list is read, so the raw id never shows before its name; an
 * Agent the list does not have, or a page outside a Workspace, keeps `model`, the stored id.
 */
export function useAgentModelName(agentId: string, model: string) {
  const workspaceId = useCurrentWorkspaceId();
  // The name only while it was resolved from the model this page holds: the list can lag a change.
  const select = useCallback(
    (list: AgentModels) =>
      list.modelIds[agentId] === model ? (list.models[agentId] ?? null) : null,
    [agentId, model],
  );
  const { data, isPending } = useQuery({
    ...agentModelsQuery(workspaceId ?? ""),
    select,
    enabled: Boolean(workspaceId && model),
  });
  if (!model || !workspaceId) return model;
  if (isPending) return undefined;
  return data || model;
}
