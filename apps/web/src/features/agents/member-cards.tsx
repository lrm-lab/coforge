import { GridListItem } from "react-aria-components";
import { Link } from "@tanstack/react-router";

import { StatusDot } from "#src/components/ui/status-dot";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { useMemberOnline } from "#src/features/workspaces/member-presence";
import { workspaceRoleLabel } from "#src/features/workspaces/workspace-role-label";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import type { MemberAgent, MemberPerson } from "#src/features/workspaces/workspaces.functions";
import { rememberSharedRect } from "#src/lib/shared-element-rect";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { AgentDisplayAvatar } from "./agent-display-avatar";
import { agentDisplay } from "./agent-status-display";
import {
  formatAgentProfileParam,
  formatPersonProfileParam,
} from "./profile-panel/profile-panel-search";
import { useAgentModelName } from "./use-agent-model-name";
import { useLiveAgentDisplay } from "./workspace-agents-realtime";

const COMPACT_CARD_CLASS =
  "relative flex min-w-0 cursor-pointer items-center gap-3 rounded-xl bg-primary px-3.5 py-3 ring-1 ring-secondary ring-inset outline-focus-ring transition-colors hover:bg-primary_hover data-focus-visible:outline-2 data-focus-visible:outline-offset-2";

function personCornerTags(person: MemberPerson, isSelf: boolean): string[] {
  const tags: string[] = [];
  if (isSelf) tags.push(m.workspace_members_you());
  if (person.role === "owner" || person.role === "admin") {
    tags.push(workspaceRoleLabel(person.role));
  }
  return tags;
}

export function PersonCard({
  person,
  isSelf,
  selected,
}: {
  person: MemberPerson;
  isSelf: boolean;
  selected: boolean;
}) {
  const online = useMemberOnline(person.id);
  const workspaceSlug = useWorkspaceSlug();
  const cornerTags = personCornerTags(person, isSelf);

  return (
    <GridListItem
      id={person.id}
      textValue={person.displayName}
      className={cn(COMPACT_CARD_CLASS, selected && "bg-chat-selected-bg ring-2 ring-brand")}
    >
      <ActorAvatar
        presence
        size="md"
        userId={person.id}
        name={person.displayName}
        src={person.avatarUrl}
      />
      <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-primary">
        <Link
          to="/w/$workspaceSlug/members"
          params={{ workspaceSlug }}
          resetScroll={false}
          search={(previous) => ({
            ...previous,
            profile: formatPersonProfileParam(person.id),
            agentTab: undefined,
          })}
          onClick={(event) => {
            const cardEl =
              event.currentTarget.closest<HTMLElement>('[role="row"]') ?? event.currentTarget;
            rememberSharedRect("member-profile-origin", cardEl);
          }}
          aria-label={m.member_person_open_profile({ name: person.displayName })}
          aria-current={selected ? "page" : undefined}
          className="rounded-sm outline-focus-ring outline-offset-4 after:absolute after:inset-0 focus-visible:outline-2"
        >
          {person.displayName}
        </Link>
        {online !== undefined && (
          <span className="sr-only">, {online ? m.member_online() : m.member_offline()}</span>
        )}
      </h2>
      {cornerTags.length > 0 && (
        <span className="flex shrink-0 items-center gap-1 rounded-sm bg-secondary px-1.5 py-0.5 text-xs font-medium text-tertiary">
          {cornerTags.map((tag) => (
            <span key={tag}>{tag}</span>
          ))}
        </span>
      )}
    </GridListItem>
  );
}

function agentComputerCaption(member: MemberAgent): { text: string; warn: boolean } {
  if (member.computerRevoked) {
    return {
      text: member.computerName
        ? `${member.computerName} (${m.member_computer_access_revoked()})`
        : m.member_computer_access_revoked(),
      warn: true,
    };
  }
  if (member.computerId === null) {
    return { text: m.member_no_computer(), warn: true };
  }
  return { text: member.computerName || m.agent_computer_unnamed(), warn: false };
}

export function AgentCard({ member, selected }: { member: MemberAgent; selected: boolean }) {
  const display = useLiveAgentDisplay(member.id);
  const view = agentDisplay(display);
  const resolvedModel = useAgentModelName(member.id, member.model);
  const workspaceSlug = useWorkspaceSlug();
  const computer = agentComputerCaption(member);
  const alertText = view.alert ? view.label : computer.warn ? computer.text : undefined;
  const subtitle = alertText ?? resolvedModel;

  return (
    <GridListItem
      id={member.id}
      textValue={member.displayName}
      className={cn(COMPACT_CARD_CLASS, selected && "bg-chat-selected-bg ring-2 ring-brand")}
    >
      <AgentDisplayAvatar
        agentId={member.id}
        name={member.displayName}
        src={member.avatarUrl}
        display={display}
        size="md"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-primary">
            <Link
              to="/w/$workspaceSlug/members"
              params={{ workspaceSlug }}
              resetScroll={false}
              search={(previous) => ({
                ...previous,
                profile: formatAgentProfileParam(member.id),
              })}
              onClick={(event) => {
                const cardEl =
                  event.currentTarget.closest<HTMLElement>('[role="row"]') ?? event.currentTarget;
                rememberSharedRect("member-profile-origin", cardEl);
              }}
              aria-label={m.agent_open_profile({ name: member.displayName })}
              aria-current={selected ? "page" : undefined}
              className="rounded-sm outline-focus-ring outline-offset-4 after:absolute after:inset-0 focus-visible:outline-2"
            >
              {member.displayName}
            </Link>
          </h2>
          {view.pulse && (
            <span className="shrink-0 rounded-sm bg-secondary px-1.5 py-0.5 text-xs font-medium text-brand-secondary">
              {m.member_agent_status_working()}
            </span>
          )}
        </div>
        {subtitle && (
          <p
            className={cn("truncate text-xs", alertText ? "text-warning-primary" : "text-tertiary")}
          >
            {subtitle}
          </p>
        )}
      </div>
    </GridListItem>
  );
}

export function AgentDirectoryRow({
  member,
  selected,
}: {
  member: MemberAgent;
  selected: boolean;
}) {
  const display = useLiveAgentDisplay(member.id);
  const view = agentDisplay(display);
  const resolvedModel = useAgentModelName(member.id, member.model);
  const workspaceSlug = useWorkspaceSlug();
  const computer = agentComputerCaption(member);
  const description = member.description.trim();

  return (
    <GridListItem
      id={member.id}
      textValue={member.displayName}
      className={cn(
        "relative flex min-w-0 cursor-pointer flex-col gap-2 px-4 py-3 outline-focus-ring transition-colors hover:bg-primary_hover data-focus-visible:outline-2 data-focus-visible:-outline-offset-2 @2xl/members:grid @2xl/members:grid-cols-[minmax(12rem,1fr)_6.5rem_10rem] @2xl/members:items-center @2xl/members:gap-3 @4xl/members:grid-cols-[minmax(14rem,1.4fr)_6.5rem_11rem_9.5rem_7.5rem]",
        selected && "bg-chat-selected-bg",
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <AgentDisplayAvatar
          agentId={member.id}
          name={member.displayName}
          src={member.avatarUrl}
          display={display}
          size="md"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h2 className="min-w-0 truncate text-sm font-semibold text-primary">
              <Link
                to="/w/$workspaceSlug/members"
                params={{ workspaceSlug }}
                resetScroll={false}
                search={(previous) => ({
                  ...previous,
                  profile: formatAgentProfileParam(member.id),
                })}
                onClick={(event) => {
                  const rowEl =
                    event.currentTarget.closest<HTMLElement>('[role="row"]') ?? event.currentTarget;
                  rememberSharedRect("member-profile-origin", rowEl);
                }}
                aria-label={m.agent_open_profile({ name: member.displayName })}
                aria-current={selected ? "page" : undefined}
                className="rounded-sm outline-focus-ring outline-offset-4 after:absolute after:inset-0 focus-visible:outline-2"
              >
                {member.displayName}
              </Link>
            </h2>
            <span className="flex shrink-0 items-center gap-1.5 text-xs text-tertiary @2xl/members:hidden">
              <StatusDot tone={view.tone} pulse={view.pulse} />
              <span>{view.label}</span>
            </span>
          </div>
          {description && <p className="truncate text-xs text-tertiary">{description}</p>}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-quaternary @2xl/members:hidden">
            {resolvedModel && <span className="truncate font-mono">{resolvedModel}</span>}
            <span className={cn("truncate", computer.warn && "text-warning-primary")}>
              {computer.text}
            </span>
            <span className="truncate">{member.owner.displayName}</span>
          </div>
        </div>
      </div>

      <div className="hidden min-w-0 items-center gap-1.5 text-xs text-secondary @2xl/members:flex">
        <StatusDot tone={view.tone} pulse={view.pulse} />
        <span className={cn("truncate", view.alert && "text-warning-primary")}>{view.label}</span>
      </div>

      <div className="hidden min-w-0 truncate font-mono text-xs text-tertiary @2xl/members:block">
        {resolvedModel || "—"}
      </div>

      <div
        className={cn(
          "hidden min-w-0 truncate text-xs @4xl/members:block",
          computer.warn ? "text-warning-primary" : "text-tertiary",
        )}
      >
        {computer.text}
      </div>

      <div className="hidden min-w-0 truncate text-end text-xs text-tertiary @4xl/members:block">
        {member.owner.displayName}
      </div>
    </GridListItem>
  );
}
