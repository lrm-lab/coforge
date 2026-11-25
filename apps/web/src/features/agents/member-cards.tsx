import { GridListItem } from "react-aria-components";
import { Link } from "@tanstack/react-router";

import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { ComputerGlyph } from "#src/features/computers/computer-status-icon";
import { useMemberOnline } from "#src/features/workspaces/member-presence";
import { workspaceRoleLabel } from "#src/features/workspaces/workspace-role-label";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import type { MemberAgent, MemberPerson } from "#src/features/workspaces/workspaces.functions";
import { rememberSharedRect } from "#src/lib/shared-element-rect";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { AgentDisplayAvatar } from "./agent-display-avatar";
import { agentDisplay } from "./agent-status-display";
import { AgentStatusMarker, AgentStatusText } from "./agent-status-marker";
import {
  formatAgentProfileParam,
  formatPersonProfileParam,
} from "./profile-panel/profile-panel-search";
import { useAgentModelName } from "./use-agent-model-name";
import { useLiveAgentDisplay } from "./workspace-agents-realtime";

/** Shared column template for `AgentsTableView` header and `AgentDirectoryRow` so headers and cells
 * stay aligned across container widths (profile closed, profile open, and narrow split panes). */
export const AGENT_TABLE_GRID_CLASS =
  "@2xl/members:grid @2xl/members:grid-cols-[minmax(12rem,1.4fr)_minmax(7.5rem,1fr)_minmax(8.5rem,1.1fr)] @2xl/members:gap-3 @[45rem]/members:grid-cols-[minmax(12rem,1.45fr)_minmax(7.5rem,0.95fr)_minmax(8.5rem,1.05fr)_minmax(7.5rem,0.85fr)]";

export const AGENT_TABLE_CREATOR_COL_CLASS = "hidden @[45rem]/members:flex";

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
  const creatorName = member.owner.displayName.trim();
  const isError = Boolean(view.alert || view.kind === "error");
  const showLiveStatus = isError || view.pulse || view.lastActiveAt !== undefined;
  const computerGlyphKind = member.computerKind ?? (member.computerRevoked ? "local" : undefined);

  return (
    <GridListItem
      id={member.id}
      textValue={member.displayName}
      className={cn(
        "relative flex min-w-0 cursor-pointer flex-col gap-2 px-4 py-3 outline-focus-ring transition-colors hover:bg-primary_hover data-focus-visible:outline-2 data-focus-visible:-outline-offset-2 @2xl/members:items-center",
        AGENT_TABLE_GRID_CLASS,
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
          {showLiveStatus ? (
            <p
              className={cn(
                "flex min-w-0 items-center gap-1.5 text-xs",
                isError ? "text-error-primary" : view.pulse ? "text-secondary" : "text-tertiary",
              )}
            >
              {(isError || view.pulse) && <AgentStatusMarker status={view} className="size-1.5" />}
              <span className="min-w-0 truncate">
                <AgentStatusText status={view} />
              </span>
            </p>
          ) : (
            description && <p className="truncate text-xs text-tertiary">{description}</p>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-tertiary @2xl/members:hidden">
            {resolvedModel && (
              <span className="min-w-0 truncate text-secondary">{resolvedModel}</span>
            )}
            <span
              className={cn(
                "inline-flex min-w-0 max-w-full items-center gap-1",
                computer.warn ? "text-warning-strong" : "text-tertiary",
              )}
            >
              {computerGlyphKind && (
                <ComputerGlyph
                  kind={computerGlyphKind}
                  aria-hidden="true"
                  className={cn(
                    "size-3.5 shrink-0",
                    computer.warn ? "text-warning-strong" : "text-tertiary",
                  )}
                />
              )}
              <span className="min-w-0 truncate">{computer.text}</span>
            </span>
            <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-tertiary">
              <ActorAvatar
                presence={false}
                size="xs"
                userId={member.owner.id}
                name={creatorName || undefined}
                src={member.owner.avatarUrl}
              />
              <span dir="auto" className="min-w-0 truncate">
                {creatorName || "—"}
              </span>
            </span>
          </div>
        </div>
      </div>

      <div
        className={cn(
          "hidden min-w-0 truncate text-sm @2xl/members:block",
          resolvedModel ? "text-secondary" : "text-quaternary",
        )}
      >
        {resolvedModel || "—"}
      </div>

      <div
        className={cn(
          "hidden min-w-0 items-center gap-1.5 text-sm @2xl/members:flex",
          computer.warn ? "text-warning-strong" : "text-secondary",
        )}
      >
        {computerGlyphKind && (
          <ComputerGlyph
            kind={computerGlyphKind}
            aria-hidden="true"
            className={cn(
              "size-4 shrink-0",
              computer.warn ? "text-warning-strong" : "text-tertiary",
            )}
          />
        )}
        <span className="min-w-0 truncate">{computer.text}</span>
      </div>

      <div
        className={cn(
          AGENT_TABLE_CREATOR_COL_CLASS,
          "min-w-0 items-center gap-2 text-sm text-secondary",
        )}
      >
        <ActorAvatar
          presence={false}
          size="xs"
          userId={member.owner.id}
          name={creatorName || undefined}
          src={member.owner.avatarUrl}
        />
        <span dir="auto" className="min-w-0 truncate">
          {creatorName || "—"}
        </span>
      </div>
    </GridListItem>
  );
}
