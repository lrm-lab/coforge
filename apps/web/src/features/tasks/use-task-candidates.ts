import { useQuery } from "@tanstack/react-query";
import type { TaskView } from "@lrm/coforge-sdk/internal";
import { useMemo } from "react";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { useCanSetAnyTaskStatus } from "./task-board-authority";
import { candidateLinks, type TaskCandidate } from "./task-relation-edits";
import { taskOverviewQuery } from "./task-overview-collection";
import { useUnfinishedTasks } from "./use-conversation-tasks";

/**
 * The Tasks a picker offers for `task`: its own conversation's unfinished ones (read the way the
 * Tasks tab reads them, which also covers a direct message) and the Workspace's channel Tasks the
 * viewer may see, from the read the Tasks page shares, so a search can reach other channels. A
 * picker mounts this only once it is open, so a popup that never picks reads neither.
 * `memberId` is the viewer's member in that conversation, so a candidate says whether they may add
 * a sub-task under it.
 */
export function useTaskCandidates(
  task: Pick<TaskView, "conversationId">,
  memberId: string | null,
): TaskCandidate[] {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const manager = useCanSetAnyTaskStatus();
  const own = useUnfinishedTasks(task.conversationId).tasks;
  const workspace = useQuery(taskOverviewQuery(workspaceId)).data?.tasks;
  const { conversationId } = task;
  return useMemo(
    () => candidateLinks(conversationId, own, workspace ?? [], { memberId, manager }),
    [conversationId, own, workspace, memberId, manager],
  );
}
