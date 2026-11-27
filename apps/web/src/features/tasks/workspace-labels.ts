import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useCallback } from "react";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { workspaceConversationChannel } from "#src/features/conversations/conversation-realtime";
import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import { decodeLabelChangedEvent, decodeLabelGroupChangedEvent } from "./label-realtime";
import { loadWorkspaceLabels } from "./labels.functions";

type WorkspaceLabels = Awaited<ReturnType<typeof loadWorkspaceLabels>>;

/** The query key of the Workspace's labels, read by every picker and refreshed by their events. */
export const workspaceLabelsKey = (workspaceId: string) => ["workspace-labels", workspaceId];

/** The labels a form holds by name; the Workspace's hold the archived ones too (task #557), and a
 * draft names a live one. */
export function draftLabels(names: readonly string[], labels: WorkspaceLabels["labels"]) {
  return names.flatMap((name) => {
    const label = labels.find((each) => each.name === name && !each.archivedAt);
    return label ? [{ id: label.id, name: label.name, color: label.color }] : [];
  });
}

/**
 * The Workspace's labels for a picker, read once and kept fresh by `label.changed.v1` (and
 * `label.group.changed.v1`, which can rename what a label is listed under), and whether the viewer
 * may recolor and delete them. The archived ones are among them, marked by `archivedAt`, so a Task
 * read before one was archived can drop it; a picker offers only the live ones.
 */
export function useWorkspaceLabels(enabled: boolean) {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const load = useServerFn(loadWorkspaceLabels);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: workspaceLabelsKey(workspaceId),
    queryFn: () => load(),
    enabled: enabled && workspaceId !== "",
    staleTime: 60_000,
  });
  const onPublication = useCallback(
    ({ data }: { data: unknown }) => {
      if (decodeLabelChangedEvent(data) || decodeLabelGroupChangedEvent(data))
        void queryClient.invalidateQueries({ queryKey: workspaceLabelsKey(workspaceId) });
    },
    [queryClient, workspaceId],
  );
  useRealtimeSubscription({
    channel: enabled && workspaceId ? workspaceConversationChannel(workspaceId) : undefined,
    onPublication,
  });
  return {
    labels: query.data?.labels ?? [],
    canManage: query.data?.canManage ?? false,
    /** Whether `canManage` is known yet, not the default it starts from. */
    loaded: query.data !== undefined,
    workspaceId,
  };
}

export type CachedLabelEntry = { color: string; archived: boolean };
export type WorkspaceLabelsIndex = ReadonlyMap<string, CachedLabelEntry>;

const EMPTY_LABELS_INDEX: WorkspaceLabelsIndex = new Map();
const labelsIndexCache = new WeakMap<WorkspaceLabels["labels"], WorkspaceLabelsIndex>();

export function indexWorkspaceLabels(
  labels: WorkspaceLabels["labels"] | undefined,
): WorkspaceLabelsIndex {
  if (!labels || labels.length === 0) return EMPTY_LABELS_INDEX;
  let index = labelsIndexCache.get(labels);
  if (!index) {
    const map = new Map<string, CachedLabelEntry>();
    for (const entry of labels) {
      map.set(entry.id, { color: entry.color, archived: entry.archivedAt != null });
    }
    index = map;
    labelsIndexCache.set(labels, index);
  }
  return index;
}

export function useCachedLabelsIndex(): WorkspaceLabelsIndex {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const cached = useQuery<WorkspaceLabels>({
    queryKey: workspaceLabelsKey(workspaceId),
    enabled: false,
  });
  return indexWorkspaceLabels(cached.data?.labels);
}

export function useCachedLabel(label: { id: string; color: string }): CachedLabelEntry {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const select = useCallback(
    (data: WorkspaceLabels) => indexWorkspaceLabels(data.labels).get(label.id) ?? null,
    [label.id],
  );
  const cached = useQuery<WorkspaceLabels, Error, CachedLabelEntry | null>({
    queryKey: workspaceLabelsKey(workspaceId),
    enabled: false,
    select,
  });
  return cached.data ?? { color: label.color, archived: false };
}

export type { WorkspaceLabels };
