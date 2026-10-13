import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";
import { memberMatchesSearch, type SearchableMember } from "./channel-member-search";

/** One Workspace human or Agent the group chat dialog offers, keyed `user:<id>` or `agent:<id>`. */
export type GroupChatCandidate = {
  key: string;
  kind: "user" | "agent";
  id: string;
  name: string;
  search: SearchableMember;
  avatarUrl: string | null;
};

/** The part of `loadWorkspaceDirectory` the picker reads. */
export type GroupChatDirectory = {
  viewerId: string;
  people: { id: string; name: string; avatarUrl: string | null }[];
  agents: {
    id: string;
    handle: string;
    name: string;
    avatarUrl: string | null;
    visibility: string;
    weeklyReportAssistant: boolean;
  }[];
};

/** The candidates in the order the directory picker lists them: Agents, then people. The viewer
 * is the creator, so never a candidate. Only public Agents that are not a weekly-report assistant
 * can join a channel (`PublicChannels.addMembers` refuses the rest), so the picker offers no others. */
export function buildGroupChatCandidates(directory: GroupChatDirectory): GroupChatCandidate[] {
  const agents: GroupChatCandidate[] = directory.agents
    .filter((agent) => agent.visibility === AGENT_VISIBILITY.PUBLIC && !agent.weeklyReportAssistant)
    .map((agent) => ({
      key: `agent:${agent.id}`,
      kind: "agent",
      id: agent.id,
      name: agent.name,
      search: { kind: "agent", displayName: agent.name, name: agent.handle },
      avatarUrl: agent.avatarUrl,
    }));
  const people: GroupChatCandidate[] = directory.people
    .filter((person) => person.id !== directory.viewerId)
    .map((person) => ({
      key: `user:${person.id}`,
      kind: "user",
      id: person.id,
      name: person.name,
      search: { kind: "user", displayName: person.name },
      avatarUrl: person.avatarUrl,
    }));
  return [...agents, ...people];
}

/** The candidates the search matches. A leading @ is how people write a handle, not part of it. */
export function filterGroupChatCandidates(
  candidates: readonly GroupChatCandidate[],
  search: string,
): GroupChatCandidate[] {
  const query = search.trim().replace(/^@/, "").trim().toLowerCase();
  return candidates.filter((entry) => memberMatchesSearch(query, entry.search));
}

/** A copy of `selected` with `key` added when `on`, removed otherwise. */
export function toggleGroupChatKey(
  selected: ReadonlySet<string>,
  key: string,
  on: boolean,
): Set<string> {
  const next = new Set(selected);
  if (on) next.add(key);
  else next.delete(key);
  return next;
}

/** The selected candidates in candidate order, so the right pane reads the same whatever order
 * the boxes were ticked in. */
export function selectedGroupChatCandidates(
  candidates: readonly GroupChatCandidate[],
  selected: ReadonlySet<string>,
): GroupChatCandidate[] {
  return candidates.filter((entry) => selected.has(entry.key));
}

/** The ids the channel-creation request takes, humans and Agents apart, from selected keys. */
export function splitGroupChatKeys(keys: Iterable<string>) {
  const userIds: string[] = [];
  const agentIds: string[] = [];
  for (const key of keys) {
    const separator = key.indexOf(":");
    const kind = key.slice(0, separator);
    const id = key.slice(separator + 1);
    if (kind === "user") userIds.push(id);
    else if (kind === "agent") agentIds.push(id);
  }
  return { userIds, agentIds };
}

/** Whether the dialog may create a group with `selectedCount` people besides the creator; the
 * sidebar's group chat needs at least two, the other channel callers none. */
export function canCreateGroupChat(selectedCount: number, minMembers: number): boolean {
  return selectedCount >= minMembers;
}
