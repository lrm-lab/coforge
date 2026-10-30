import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Button as AriaButton, Disclosure, DisclosurePanel, Heading } from "react-aria-components";
import { ChevronDown, DotsHorizontal, Plus, SearchLg, Trash01 } from "@untitledui/icons";

import { IdentityAvatar } from "#src/features/avatars/identity-avatar";
import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { Input } from "#src/components/base/input/input";
import { AgentDisplayAvatar } from "#src/features/agents/agent-display-avatar";
import { AgentHoverCard } from "#src/features/agents/agent-hover-card";
import { agentDisplay } from "#src/features/agents/agent-activity-presentation";
import { useAgentDisplays } from "#src/features/agents/workspace-agents-realtime";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { useCoarsePointer } from "#src/hooks/use-coarse-pointer";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { setPublicChannelMemberRole } from "./channels.functions";
import { RemoveMemberDialog, ServerAdminRoleDialog } from "./channel-member-dialogs";
import { memberMatchesSearch } from "./channel-member-search";
import { AddMembersView, useCreatedAgentJoin } from "./channel-add-members-view";
import { useChannelMembers, type ChannelMembers, type RosterMember } from "./channel-members-query";
import type { AgentProfileTab as AgentProfileTabId } from "#src/features/agents/profile-panel/profile-panel-search";
import { PersonHoverCard } from "./person-hover-card";
import { channelMembersQueryKey } from "./conversation-query-keys";
import { mentionKey } from "./mention-text";

/** The two views of the members page: the roster, and adding people to it. */
export type ChannelMembersView = "members" | "add";

/** A Workspace owner or admin administers every channel, whatever their role in it. */
function isServerAdmin(member: { serverRole?: string | null }) {
  return member.serverRole === "owner" || member.serverRole === "admin";
}

/** Owner and admin are Workspace roles; a channel admin is one by this channel's own role. A plain
 * member has no label: a badge on every row would say nothing. */
function roleLabel(member: { serverRole?: string | null; channelRole: string }) {
  if (member.serverRole === "owner") return m.channel_members_role_owner();
  if (member.serverRole === "admin") return m.channel_members_role_admin();
  if (member.channelRole === "admin") return m.channel_members_role_channel_admin();
  return undefined;
}

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

/** A roster member whose profile opens in the roster's place: an Agent or a person. */
export type RosterProfile = { kind: "agent" | "user"; id: string };

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
  const displays = useAgentDisplays();
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
        display={member.kind === "agent" ? displays.get(member.id) : undefined}
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

/** One roster row: identity, then at its right edge the role badge and the role and remove actions
 * — revealed in the badge's place on hover or keyboard focus, or behind a menu button when
 * `actionsInMenu`. */
const MemberRow = memo(function MemberRow({
  member,
  display,
  canChangeRole,
  roleBusy,
  canRemove,
  actionsInMenu,
  onToggleRole,
  onRemove,
  onOpenProfile,
  autoFocus,
}: {
  member: RosterMember;
  display: AgentDisplaySnapshot | undefined;
  canChangeRole: boolean;
  roleBusy: boolean;
  canRemove: boolean;
  /** Some row of the roster has actions and they sit behind a menu button; a row without any keeps
   * the button's room, so every badge still ends on one line. */
  actionsInMenu: boolean;
  onToggleRole: (member: RosterMember) => void;
  onRemove: (member: RosterMember) => void;
  onOpenProfile: (profile: RosterProfile, tab?: AgentProfileTabId) => void;
  autoFocus: boolean;
}) {
  const hasActions = canChangeRole || canRemove;
  const role = roleLabel(member);
  const demotes = member.channelRole === "admin" || isServerAdmin(member);
  const roleAction = demotes ? m.channel_members_demote() : m.channel_members_promote();
  const actionsLabel = m.channel_members_actions_name({ name: member.displayName });
  const badge = role && (
    <Badge type="modern" size="sm" color="gray" className="font-mono">
      {role}
    </Badge>
  );
  // The same peek the channel header's faces give (task #211): hovering an avatar shows the
  // profile card; pressing it (or the name) opens the profile. Avatar and name are separate
  // press targets — a hover-card trigger nested inside the row's button would nest buttons.
  const avatarTriggerClassName =
    "shrink-0 rounded-[0.4375rem] outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2";
  const namePress = () => onOpenProfile({ kind: member.kind, id: member.id });
  const nameBlock = (
    <span className="min-w-0 text-left">
      <span
        className={cn(
          "block truncate text-sm text-primary",
          member.kind === "user" ? "font-semibold" : "font-medium",
        )}
      >
        {member.displayName}
      </span>
      {member.kind === "agent" && (
        <span className="block truncate text-xs text-tertiary">{agentDisplay(display).label}</span>
      )}
    </span>
  );
  return (
    <li className="group flex min-h-16 items-center gap-3 rounded-lg p-2 hover:bg-primary_hover md:min-h-0 md:px-3">
      {member.kind === "agent" ? (
        <AgentHoverCard
          agentId={member.id}
          name={member.displayName}
          handle={"name" in member ? member.name : undefined}
          src={member.avatarUrl}
          trigger={
            <AgentDisplayAvatar
              agentId={member.id}
              name={member.displayName}
              src={member.avatarUrl}
              display={display}
            />
          }
          triggerClassName={avatarTriggerClassName}
          onOpenProfile={(agentId, tab) => onOpenProfile({ kind: "agent", id: agentId }, tab)}
        />
      ) : (
        <PersonHoverCard
          label={m.member_person_open_profile({ name: member.displayName })}
          onPress={namePress}
          triggerClassName={avatarTriggerClassName}
          trigger={
            <IdentityAvatar
              size="sm"
              alt=""
              src={member.avatarUrl ?? undefined}
              name={member.displayName}
            />
          }
          userId={member.id}
          name={member.displayName}
          loaded={{
            src: member.avatarUrl,
            description: member.description,
            serverRole: member.serverRole,
            channelRole: member.channelRole,
          }}
        />
      )}
      <AriaButton
        aria-label={
          member.kind === "agent"
            ? m.agent_open_profile({ name: member.displayName })
            : m.member_person_open_profile({ name: member.displayName })
        }
        autoFocus={autoFocus}
        className="flex min-w-0 cursor-pointer items-center rounded-md outline-focus-ring focus-visible:outline-2"
        onPress={namePress}
      >
        {nameBlock}
      </AriaButton>
      {actionsInMenu ? (
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {badge}
          {hasActions ? (
            <Dropdown.Root>
              <ButtonUtility
                tooltip={actionsLabel}
                icon={DotsHorizontal}
                color="tertiary"
                className="size-11"
              />
              <Dropdown.Popover placement="bottom end" className="w-48">
                <Dropdown.Menu aria-label={actionsLabel}>
                  {canChangeRole && (
                    <Dropdown.Item
                      id="role"
                      label={roleAction}
                      isDisabled={roleBusy}
                      onAction={() => onToggleRole(member)}
                    />
                  )}
                  {canRemove && (
                    <Dropdown.Item
                      id="remove"
                      label={m.channel_members_remove_action()}
                      onAction={() => onRemove(member)}
                    />
                  )}
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown.Root>
          ) : (
            <span aria-hidden="true" className="size-11" />
          )}
        </span>
      ) : (
        // The badge and the actions share one grid cell; the badge gives way to them on hover or
        // keyboard focus. The actions are hidden by opacity, not visibility, so they stay in the
        // tab order and a keyboard focus reveals them.
        <span className="ml-auto grid shrink-0 items-center justify-items-end">
          {badge && (
            <span
              className={cn(
                "col-start-1 row-start-1 flex",
                hasActions && "group-focus-within:opacity-0 group-hover:opacity-0",
              )}
            >
              {badge}
            </span>
          )}
          {hasActions && (
            <span className="col-start-1 row-start-1 flex items-center gap-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
              {canChangeRole && (
                <Button
                  size="sm"
                  color="secondary"
                  isDisabled={roleBusy}
                  aria-label={
                    demotes
                      ? m.channel_members_demote_name({ name: member.displayName })
                      : m.channel_members_promote_name({ name: member.displayName })
                  }
                  onPress={() => onToggleRole(member)}
                >
                  {roleAction}
                </Button>
              )}
              {canRemove && (
                <ButtonUtility
                  icon={Trash01}
                  color="tertiary"
                  className="size-8"
                  tooltip={m.channel_members_remove_name({ name: member.displayName })}
                  onClick={() => onRemove(member)}
                />
              )}
            </span>
          )}
        </span>
      )}
    </li>
  );
});

function MemberGroup({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <Disclosure isExpanded={expanded} onExpandedChange={setExpanded}>
      <Heading level={3}>
        <AriaButton
          slot="trigger"
          className="flex w-full cursor-pointer items-center gap-1.5 px-4 py-2 text-xs font-semibold text-tertiary outline-focus-ring focus-visible:outline-2 focus-visible:-outline-offset-2 md:px-6"
        >
          <ChevronDown
            aria-hidden="true"
            className={cn("size-4 shrink-0 transition-transform", !expanded && "-rotate-90")}
          />
          <span>
            {label} · <span className="tabular-nums">{count}</span>
          </span>
        </AriaButton>
      </Heading>
      {/* A collapsed panel is `hidden="until-found"`, which Tailwind's preflight leaves displayed. */}
      <DisclosurePanel className={cn(!expanded && "hidden")}>
        {/* Inset, so a row's hover background has room around it. */}
        <ul className="px-2 md:px-3">{expanded && children}</ul>
      </DisclosurePanel>
    </Disclosure>
  );
}
