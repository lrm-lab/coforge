import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";

import {
  useCurrentWorkspaceId,
  useVisibleAgentDirectory,
} from "#src/features/agents/workspace-agents-realtime";
import { useTaskConversationsOn } from "#src/features/tasks/use-task-conversations-on";
import { m } from "#src/paraglide/messages";
import { subscribeComposerDrafts } from "./composer-draft";
import { deviceDrafts, type DeviceDraft } from "./composer-drafts-index";
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

/** A DM as a draft row shows it, named as the sidebar names it. */
function draftDirect({ name, self, peer, agent }: DirectEntry): DraftDirect {
  const label = self ? m.conversation_dm_self_name({ name }) : name;
  return peer.kind === "people"
    ? { name: label, peer: { kind: "people", userId: peer.userId, avatarUrl: peer.avatarUrl } }
    : {
        name: label,
        peer: { kind: "agent", agentId: peer.agentId, avatarUrl: agent?.avatarUrl ?? null },
      };
}

/** The channels and DMs of the current Workspace, by conversation id: what tells its drafts from
 * those written in another Workspace on this device. An archived channel is not in it, nor a DM
 * with an Agent that is gone: the sidebar lists neither. Channels are built again only when the
 * channels change, DMs only when the DMs or Agents do. */
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
          { kind: "channel", channel: { name: channel.name, visibility: channel.visibility } },
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

/** What the server renders: this device's drafts are not known there. */
const NO_DRAFTS: DeviceDraft[] = [];

/** The Workspace's drafts on this device, the most recently edited first, kept current as the
 * viewer types in any composer. Task discussion drafts are listed only while task conversations
 * are on. */
export function useDraftRows(): DraftRow[] {
  const homes = useDraftHomes();
  const taskDrafts = useTaskConversationsOn() === true;
  const drafts = useSyncExternalStore(subscribeComposerDrafts, deviceDrafts, () => NO_DRAFTS);
  return useMemo(() => resolveDrafts(drafts, homes, { taskDrafts }), [drafts, homes, taskDrafts]);
}

/** How many drafts the Workspace has. The snapshot is the number, so a keystroke renders the
 * reader only when the count moves. */
export function useDraftCount(): number {
  const homes = useDraftHomes();
  const taskDrafts = useTaskConversationsOn() === true;
  const count = useCallback(
    () => countDrafts(deviceDrafts(), homes, { taskDrafts }),
    [homes, taskDrafts],
  );
  return useSyncExternalStore(subscribeComposerDrafts, count, () => 0);
}
