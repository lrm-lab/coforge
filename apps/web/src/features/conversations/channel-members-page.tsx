import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Plus, SearchLg } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { HoverCardGroup } from "#src/components/ui/hover-popover";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { useCoarsePointer } from "#src/hooks/use-coarse-pointer";
import { m } from "#src/paraglide/messages";
import { setPublicChannelMemberRole } from "./channels.functions";
import { RemoveMemberDialog, ServerAdminRoleDialog } from "./channel-member-dialogs";
import { isServerAdmin, MemberGroup, MemberRow, type RosterProfile } from "./channel-member-row";
import { memberMatchesSearch } from "./channel-member-search";
import { AddMembersView, useCreatedAgentJoin } from "./channel-add-members-view";
import { useChannelMembers, type ChannelMembers, type RosterMember } from "./channel-members-query";
import type { AgentProfileTab as AgentProfileTabId } from "#src/features/agents/profile-panel/profile-panel-search";
import { channelMembersQueryKey } from "./conversation-query-keys";
import { mentionKey } from "./mention-text";

export type { RosterProfile };

export type ChannelMembersView = "members" | "add";

/**
 * A channel's members as a page of its settings panel: the roster grouped by humans and Agents
 * with a search, each row's role and, for those allowed, its role and remove actions; and the
 * add view, where a member picks Workspace Agents and people to add, or creates an Agent that then
 * joins. It reads and updates the same query as the panel's Members strip.
 */
export function ChannelMembersPage({
  channelId,
  channelName,
  viewerId,
  canCreateAgents,
  view,
  onViewChange,
  roster,
}: {
  channelId: string;
  channelName: string;
  /** The viewer's own user id: their row offers no role change. */
  viewerId?: string;
  /** Whether the add view may create an Agent (a Workspace owner or admin). */
  canCreateAgents: boolean;
  view: ChannelMembersView;
  onViewChange: (view: ChannelMembersView) => void;
  roster: RosterState;
}) {
  const members = useChannelMembers(channelId);
  const createdAgentJoin = useCreatedAgentJoin(channelId);
  if (members.isPending)
    return <p className="px-4 py-6 text-sm text-tertiary md:px-6">{m.channel_members_loading()}</p>;
  if (members.isError)
    return (
      <p role="alert" className="px-4 py-6 text-sm text-error-primary md:px-6">
        {m.channel_members_load_error()}
      </p>
    );
  return view === "add" ? (
    <AddMembersView
      channelId={channelId}
      channelName={channelName}
      canCreateAgents={canCreateAgents}
      createdAgentJoin={createdAgentJoin}
      data={members.data}
      onDone={() => onViewChange("members")}
      onOpenAgent={(agentId) => roster.onOpenProfile({ kind: "agent", id: agentId })}
    />
  ) : (
    <MembersRoster
      channelId={channelId}
      channelName={channelName}
      viewerId={viewerId}
      data={members.data}
      onAdd={() => onViewChange("add")}
      roster={roster}
    />
  );
}

/** The roster's state that outlives it while a member's profile is open in its place, so Back
 * returns to the same search, with focus on the row that opened the profile. */
export type RosterState = {
  search: string;
  onSearchChange: (search: string) => void;
  /** `tab` carries a requested profile tab (e.g. the Agent card's Recent activity link); without
   * it the panel opens the profile on its default tab. */
  onOpenProfile: (profile: RosterProfile, tab?: AgentProfileTabId) => void;
  /** The member whose profile was just left: their row takes focus. */
  returnFocus?: RosterProfile;
};

function MembersRoster({
  channelId,
  channelName,
  viewerId,
  data,
  onAdd,
  roster: { search, onSearchChange, onOpenProfile, returnFocus },
}: {
  channelId: string;
  channelName: string;
  viewerId?: string;
  data: ChannelMembers;
  onAdd: () => void;
  roster: RosterState;
}) {
  const queryClient = useQueryClient();
  const setRole = useServerFn(setPublicChannelMemberRole);
  const [roleTarget, setRoleTarget] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState<RosterMember | null>(null);
  const [serverAdmin, setServerAdmin] = useState<RosterMember | null>(null);
  const query = search.trim().toLowerCase();
  const humans = useMemo(
    () =>
      data.humans
        .filter((human) =>
          memberMatchesSearch(query, { kind: "user", displayName: human.displayName }),
        )
        .map((human): RosterMember => ({ kind: "user", ...human })),
    [data.humans, query],
  );
  const agents = useMemo(
    () =>
      data.agents
        .filter((agent) =>
          memberMatchesSearch(query, {
            kind: "agent",
            displayName: agent.displayName,
            name: agent.name,
          }),
        )
        .map((agent): RosterMember => ({ kind: "agent", ...agent })),
    [data.agents, query],
  );
  const total = data.humans.length + data.agents.length;
  const hasCandidates = data.candidates.humans.length + data.candidates.agents.length > 0;
  const canManageRoles = data.channelCapabilities.manage_roles;
  // Rows keep their actions behind a menu button on a coarse pointer or below `md`, where hover
  // reveal is unavailable or the row is too narrow for inline buttons.
  const coarsePointer = useCoarsePointer();
  const wideViewport = useBreakpoint("md");
  const actionsInMenu =
    (coarsePointer || !wideViewport) && (canManageRoles || data.canRemoveMembers);

  // Stable across renders, so a live status update re-renders only the rows whose display changed.
  const toggleRole = useCallback(
    async (member: RosterMember) => {
      if (isServerAdmin(member)) {
        setServerAdmin(member);
        return;
      }
      setRoleTarget(member.id);
      setError("");
      try {
        await setRole({
          data: {
            channelId,
            ...(member.kind === "user" ? { userId: member.id } : { agentId: member.id }),
            role: member.channelRole === "admin" ? "member" : "admin",
          },
        });
        await queryClient.invalidateQueries({ queryKey: channelMembersQueryKey(channelId) });
      } catch {
        setError(m.channel_members_role_error());
      } finally {
        setRoleTarget(null);
      }
    },
    [channelId, queryClient, setRole],
  );
  function rowFor(member: RosterMember) {
    const self = member.kind === "user" && member.id === viewerId;
    return (
      <MemberRow
        key={mentionKey(member)}
        member={member}
        canChangeRole={canManageRoles && !self}
        roleBusy={roleTarget === member.id}
        canRemove={data.canRemoveMembers}
        actionsInMenu={actionsInMenu}
        onToggleRole={toggleRole}
        onRemove={setRemoving}
        onOpenProfile={onOpenProfile}
        autoFocus={member.kind === returnFocus?.kind && member.id === returnFocus.id}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-secondary px-4 py-3 md:px-6">
        <Input
          size="sm"
          aria-label={m.channel_members_search_placeholder()}
          placeholder={m.channel_members_search_placeholder()}
          icon={SearchLg}
          value={search}
          onChange={onSearchChange}
        />
      </div>
      {error && (
        <p role="alert" className="px-4 pt-3 text-sm text-error-primary md:px-6">
          {error}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        <HoverCardGroup>
          {humans.length > 0 && (
            <MemberGroup label={m.channel_members_humans()} count={humans.length}>
              {humans.map(rowFor)}
            </MemberGroup>
          )}
          {agents.length > 0 && (
            <MemberGroup label={m.channel_members_agents()} count={agents.length}>
              {agents.map(rowFor)}
            </MemberGroup>
          )}
        </HoverCardGroup>
        {total === 0 && (
          <p className="px-4 py-4 text-center text-sm text-tertiary md:px-6">
            {m.channel_members_none()}
          </p>
        )}
        {total > 0 && humans.length === 0 && agents.length === 0 && (
          <p className="px-4 py-4 text-center text-sm text-tertiary md:px-6">
            {m.channel_members_no_matches({ query: search.trim() })}
          </p>
        )}
      </div>
      {data.canAddMembers && (
        <div className="shrink-0 border-t border-secondary px-4 py-3 md:px-6">
          <Button
            color="secondary"
            iconLeading={Plus}
            className="w-full"
            isDisabled={!hasCandidates}
            onPress={onAdd}
          >
            {m.channel_members_add_member()}
          </Button>
        </div>
      )}
      {removing && (
        <RemoveMemberDialog
          channelId={channelId}
          channelName={channelName}
          member={removing}
          onClose={() => setRemoving(null)}
        />
      )}
      {serverAdmin && (
        <ServerAdminRoleDialog member={serverAdmin} onClose={() => setServerAdmin(null)} />
      )}
    </div>
  );
}
