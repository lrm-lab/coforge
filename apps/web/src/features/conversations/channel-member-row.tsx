import { memo, useState, type ReactNode } from "react";
import { Button as AriaButton, Disclosure, DisclosurePanel, Heading } from "react-aria-components";
import { ChevronDown, DotsHorizontal, Trash01 } from "@untitledui/icons";

import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { AgentDisplayAvatar } from "#src/features/agents/agent-display-avatar";
import { AgentHoverCard } from "#src/features/agents/agent-hover-card";
import { agentDisplay } from "#src/features/agents/agent-status-display";
import { AgentStatusLine } from "#src/features/agents/agent-status-marker";
import { useLiveAgentDisplay } from "#src/features/agents/workspace-agents-realtime";
import type { AgentProfileTab as AgentProfileTabId } from "#src/features/agents/profile-panel/profile-panel-search";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { formatNumber } from "#src/lib/format-number";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import type { RosterMember } from "./channel-members-query";
import { PersonHoverCard } from "./person-hover-card";

export type RosterProfile = { kind: "agent" | "user"; id: string };

export function isServerAdmin(member: { serverRole?: string | null }) {
  return member.serverRole === "owner" || member.serverRole === "admin";
}

function roleLabel(member: { serverRole?: string | null; channelRole: string }) {
  if (member.serverRole === "owner") return m.channel_members_role_owner();
  if (member.serverRole === "admin") return m.channel_members_role_admin();
  if (member.channelRole === "admin") return m.channel_members_role_channel_admin();
  return undefined;
}

export const MemberRow = memo(function MemberRow({
  member,
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
  canChangeRole: boolean;
  roleBusy: boolean;
  canRemove: boolean;
  actionsInMenu: boolean;
  onToggleRole: (member: RosterMember) => void;
  onRemove: (member: RosterMember) => void;
  onOpenProfile: (profile: RosterProfile, tab?: AgentProfileTabId) => void;
  autoFocus: boolean;
}) {
  const display = useLiveAgentDisplay(member.kind === "agent" ? member.id : "");
  const hasActions = canChangeRole || canRemove;
  const role = roleLabel(member);
  const demotes = member.channelRole === "admin" || isServerAdmin(member);
  const roleAction = demotes ? m.channel_members_demote() : m.channel_members_promote();
  const actionsLabel = m.channel_members_actions_name({ name: member.displayName });
  const badge = role && (
    <Badge type="modern" size="sm" color="gray">
      {role}
    </Badge>
  );
  const avatarTriggerClassName =
    "shrink-0 rounded-[0.4375rem] outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2";
  const namePress = () => onOpenProfile({ kind: member.kind, id: member.id });
  const nameBlock = (
    <span className="min-w-0 flex-1 text-start">
      <span
        dir="auto"
        className={cn(
          "block truncate text-sm text-primary",
          member.kind === "user" ? "font-semibold" : "font-medium",
        )}
      >
        {member.displayName}
      </span>
      {member.kind === "agent" && <AgentStatusLine status={agentDisplay(display)} />}
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
            <ActorAvatar
              presence
              size="sm"
              alt=""
              userId={member.id}
              src={member.avatarUrl ?? null}
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
        className="flex min-w-0 flex-1 cursor-pointer items-center rounded-md outline-focus-ring focus-visible:outline-2"
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
                  {canChangeRole && canRemove && <Dropdown.Separator />}
                  {canRemove && (
                    <Dropdown.Item
                      id="remove"
                      label={m.channel_members_remove_action()}
                      tone="destructive"
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
        <span className="ml-auto grid shrink-0 items-center justify-items-end">
          {badge && (
            <span
              className={cn(
                "col-start-1 row-start-1 flex transition-opacity duration-(--duration-label-out) ease-in",
                hasActions &&
                  "group-focus-within:opacity-0 group-hover:opacity-0 group-hover:duration-(--duration-label-in) group-hover:ease-out",
              )}
            >
              {badge}
            </span>
          )}
          {hasActions && (
            <span className="col-start-1 row-start-1 flex items-center gap-1 opacity-0 transition-opacity duration-(--duration-label-out) ease-in group-focus-within:opacity-100 group-hover:opacity-100 group-hover:duration-(--duration-label-in) group-hover:ease-out">
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

export function MemberGroup({
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
            className={cn(
              "size-4 shrink-0 transition-transform duration-(--duration-sm) ease-in-out motion-reduce:transition-none",
              !expanded && "-rotate-90",
            )}
          />
          <span>
            {label} · <span className="tabular-nums">{formatNumber(count, getLocale())}</span>
          </span>
        </AriaButton>
      </Heading>
      <DisclosurePanel className={cn(!expanded && "hidden")}>
        <ul className="px-2 md:px-3">{expanded && children}</ul>
      </DisclosurePanel>
    </Disclosure>
  );
}
