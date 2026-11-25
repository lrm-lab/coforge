import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";

import {
  useCurrentWorkspaceId,
  useVisibleAgentDirectory,
} from "#src/features/agents/workspace-agents-realtime";
import { m } from "#src/paraglide/messages";
import { subscribeComposerDrafts } from "./composer-draft";
import {
  deviceDrafts,
  hasConversationDraft,
  subscribeConversationDraft,
  type DeviceDraft,
} from "./composer-drafts-index";
import { channelNamesQuery } from "./conversation-queries";
import type { DirectEntry } from "./conversation-directory-rows";
import { directEntries } from "./directory-layout";
import {
  countDrafts,
  resolveDrafts,
  type DraftDirect,
  type DraftHome,
  type DraftRow,
} from "./drafts-model";
import { useSidebarLists } from "./sidebar-lists";

function draftDirect({ name, self, peer, agent }: DirectEntry): DraftDirect {
  const label = self ? m.conversation_dm_self_name({ name }) : name;
  return peer.kind === "people"
    ? { name: label, peer: { kind: "people", userId: peer.userId, avatarUrl: peer.avatarUrl } }
    : {
        name: label,
        peer: { kind: "agent", agentId: peer.agentId, avatarUrl: agent?.avatarUrl ?? null },
      };
}

function useDraftHomes(): ReadonlyMap<string, DraftHome> {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const channelNames = useSuspenseQuery(channelNamesQuery(workspaceId)).data;
  const { directs, viewerId } = useSidebarLists();
  const agents = useVisibleAgentDirectory();
  const channelHomes = useMemo(
    () =>
      channelNames
        .filter((channel) => !channel.archived)
        .map((channel): [string, DraftHome] => [
          channel.id,
          {
            kind: "channel",
            channel: {
              name: channel.name,
              visibility: channel.visibility,
              members: channel.members,
            },
          },
        ]),
    [channelNames],
  );
  const directHomes = useMemo(
    () =>
      directEntries(directs.rows, agents, viewerId).map((entry): [string, DraftHome] => [
        entry.conversationId,
        { kind: "dm", direct: draftDirect(entry) },
      ]),
    [directs.rows, agents, viewerId],
  );
  return useMemo(() => new Map([...channelHomes, ...directHomes]), [channelHomes, directHomes]);
}

const NO_DRAFTS: DeviceDraft[] = [];

export function useDraftRows(): DraftRow[] {
  const homes = useDraftHomes();
  const drafts = useSyncExternalStore(subscribeComposerDrafts, deviceDrafts, () => NO_DRAFTS);
  return useMemo(() => resolveDrafts(drafts, homes), [drafts, homes]);
}

export function useDraftCount(): number {
  const homes = useDraftHomes();
  const count = useCallback(() => countDrafts(deviceDrafts(), homes), [homes]);
  return useSyncExternalStore(subscribeComposerDrafts, count, () => 0);
}

export function useHasConversationDraft(conversationId: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribeConversationDraft(conversationId, onStoreChange),
    [conversationId],
  );
  const check = useCallback(() => hasConversationDraft(conversationId), [conversationId]);
  return useSyncExternalStore(subscribe, check, () => false);
}
