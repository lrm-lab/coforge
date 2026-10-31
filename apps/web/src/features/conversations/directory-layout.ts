import type { LiveAgent } from "#src/features/agents/workspace-agents-realtime";
import type { ChatSection } from "./chat-section.schemas";
import { sortSectionRows, type SortableRow } from "./chat-section-sort";
import type { DirectEntry, DirectoryChannel } from "./conversation-directory-rows";
import {
  channelRowKey,
  directRowKey,
  splitPinnedConversations,
  type DirectoryLayout,
} from "./pinned-conversations";
import type { DirectRow } from "./sidebar-rows";

/**
 * Where every row of the Chat directory goes: the channels (joined first), one entry per DM with
 * its name and live Agent, each section's rows by key (`base`), and the order a row dragged out of
 * Pinned returns to (`natural`). Pure, so the directory derives it once per list change: the drag
 * reads `base` and `natural` on every pointer move.
 */
export function directoryLayout({
  channels,
  agents,
  directRows: directRowList,
  viewerId,
  sections,
  locale,
}: {
  channels: readonly DirectoryChannel[];
  agents: readonly LiveAgent[];
  directRows: readonly DirectRow[];
  viewerId?: string;
  sections: readonly ChatSection[];
  locale?: string;
}) {
  const sortedChannels = [...channels].sort((left, right) =>
    left.joined === right.joined ? 0 : left.joined ? -1 : 1,
  );
  // One row per existing DM (an Agent or member the viewer never wrote to has none), Agents and
  // members mixed in the list's order. A DM with an Agent that is gone is left out; a closed one is
  // left out of its section by the split.
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const directRows = directRowList.flatMap((row): DirectEntry[] => {
    if (row.peer.kind === "people")
      return [{ ...row, name: row.peer.displayName, self: row.peer.userId === viewerId }];
    const agent = agentsById.get(row.peer.agentId);
    return agent ? [{ ...row, name: agent.displayName, agent, self: false }] : [];
  });
  const split = splitPinnedConversations(sortedChannels, directRows);
  const base: DirectoryLayout = {
    pinned: split.pinned.map((entry) =>
      entry.kind === "channel" ? channelRowKey(entry.id) : directRowKey(entry.id),
    ),
    channels: split.channels.map((channel) => channelRowKey(channel.id)),
    agents: split.directs.map((direct) => directRowKey(direct.conversationId)),
  };
  // A closed DM that is still pinned is included, so it can be seen while it is dragged.
  const natural = {
    channels: sortedChannels.map((channel) => channelRowKey(channel.id)),
    agents: directRows
      .filter((direct) => direct.pinned || !direct.hidden)
      .map((direct) => directRowKey(direct.conversationId)),
  };
  // What a custom section's sort reads from each row it may hold, by conversation id: a row in no
  // built-in section (a channel the viewer is not in, a closed DM) is in none of these either.
  const available = new Set([...base.channels, ...base.agents]);
  const sortable = new Map<string, SortableRow>();
  for (const channel of sortedChannels) {
    const key = channelRowKey(channel.id);
    const lastMessageAt = channel.lastMessage?.createdAt ?? null;
    if (available.has(key)) sortable.set(channel.id, { key, name: channel.name, lastMessageAt });
  }
  for (const direct of directRows) {
    const key = directRowKey(direct.conversationId);
    const { name, lastMessageAt } = direct;
    if (available.has(key)) sortable.set(direct.conversationId, { key, name, lastMessageAt });
  }
  for (const section of sections) {
    const rows = section.conversationIds.flatMap((id) => sortable.get(id) ?? []);
    const keys = sortSectionRows(rows, section.sortMode, locale);
    base[`custom:${section.id}`] = keys;
    const grouped = new Set(keys);
    base.channels = base.channels.filter((key) => !grouped.has(key));
    base.agents = base.agents.filter((key) => !grouped.has(key));
  }
  return { sortedChannels, directRows, base, natural };
}
