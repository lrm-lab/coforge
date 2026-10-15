import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useHydrated, useNavigate } from "@tanstack/react-router";
import { MessageSquare01 as MessageSquare, UserX01, XClose as X } from "@untitledui/icons";

import { Badge } from "#src/components/base/badges/badges";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Button } from "#src/components/base/buttons/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#src/components/ui/empty";
import { Skeleton } from "#src/components/ui/skeleton";
import { isAppErrorCode } from "#src/lib/app-error";
import { formatCalendarDate } from "#src/lib/dates";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { useOpenDirectConversation } from "#src/features/conversations/open-direct-conversation";
import { MemberAvatar } from "#src/features/workspaces/member-avatar";
import { workspaceRoleLabel } from "#src/features/workspaces/workspace-members-panel";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import type { MemberPersonProfile } from "#src/features/workspaces/workspaces.functions";
import { AgentDisplayAvatar } from "./agent-display-avatar";
import { memberPersonQuery } from "./member-directory-queries";
import { useLiveAgentDisplay } from "./workspace-agents-realtime";
import { SECTION_CAPTION_CLASS, SUBFIELD_LABEL_CLASS } from "./profile-panel/inline-edit-field";
import { PanelMessage } from "./profile-panel/panel-message";
import { formatAgentProfileParam } from "./profile-panel/profile-panel-search";

const appRoute = getRouteApi("/w/$workspaceSlug");

/**
 * The Members page's right-hand panel for a person (`profile=user:<id>`), the human counterpart of
 * `AgentProfilePanel`: who they are (name, description, email), their Workspace role and join
 * date, and the Agents they created that the viewer may see. Read-only; a person edits their own
 * profile in Settings → Account, and owners/admins change roles in Settings → Members.
 */
export function PersonProfilePanel({
  workspaceId,
  userId,
  onClose,
}: {
  workspaceId: string;
  userId: string;
  onClose: () => void;
}) {
  const person = useQuery(memberPersonQuery(workspaceId, userId));
  const openDirectConversation = useOpenDirectConversation();

  if (person.isPending) {
    return (
      <aside aria-busy="true" aria-label={m.agent_profile_loading()} className="flex flex-col">
        <div className="flex h-12 items-center gap-2 px-5">
          <Skeleton className="size-8 rounded-full" />
          <Skeleton className="h-4 w-32" />
        </div>
        <div className="space-y-3 border-t border-secondary px-6 py-5">
          <Skeleton className="size-14 rounded-full" />
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-64" />
        </div>
      </aside>
    );
  }

  if (person.isError) {
    const missing =
      isAppErrorCode(person.error, "NOT_FOUND") || isAppErrorCode(person.error, "ACCESS_DENIED");
    return (
      <aside className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center justify-end px-5">
          <CloseButton onClose={onClose} />
        </div>
        {missing ? (
          <Empty className="px-6">
            <EmptyHeader>
              <EmptyMedia>
                <UserX01 aria-hidden="true" className="size-8 text-tertiary" />
              </EmptyMedia>
              <EmptyTitle role="heading" aria-level={2}>
                {m.member_person_not_found_title()}
              </EmptyTitle>
              <EmptyDescription>{m.member_person_not_found_description()}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <PanelMessage
            alert
            text={m.member_person_load_error()}
            onRetry={() => void person.refetch()}
          />
        )}
      </aside>
    );
  }

  const profile = person.data;
  return (
    <aside aria-label={profile.displayName} className="flex min-h-0 flex-1 flex-col">
      {/* Same 48px band and 20px gutter as the Agent panel's header. */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-secondary px-5">
        <MemberAvatar
          size="sm"
          userId={profile.id}
          name={profile.displayName}
          src={profile.avatarUrl}
        />
        <p className="min-w-0 flex-1 truncate text-md font-medium tracking-tight text-secondary">
          {profile.displayName}
        </p>
        {/* Every member offers it, the viewer too: that opens their DM with themself. */}
        <ButtonUtility
          icon={MessageSquare}
          size="sm"
          tooltip={m.agent_profile_panel_message()}
          onClick={() => void openDirectConversation({ userId: profile.id })}
        />
        <CloseButton onClose={onClose} />
      </header>
      <PersonProfileBody profile={profile} />
    </aside>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <ButtonUtility
      icon={X}
      size="sm"
      color="tertiary"
      className="-mr-1.5"
      tooltip={m.controls_close()}
      onClick={onClose}
    />
  );
}

function PersonProfileBody({ profile }: { profile: MemberPersonProfile }) {
  const workspaceSlug = useWorkspaceSlug();
  const navigate = useNavigate();
  const timeZone = appRoute.useLoaderData().timeZone;
  const locale = getLocale();
  // Without a time-zone preference the server and browser zones differ, so the date is only
  // formatted once hydrated.
  const hydrated = useHydrated();
  const joinedOn =
    timeZone || hydrated ? formatCalendarDate(profile.joinedAt, timeZone, locale) : "";

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <section className="flex items-center gap-4 border-b border-secondary px-6 py-5">
        <MemberAvatar
          size="xl"
          userId={profile.id}
          name={profile.displayName}
          src={profile.avatarUrl}
        />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold text-primary">
            {profile.displayName}
            {profile.isViewer && (
              <span className="ml-1.5 text-md font-normal text-tertiary">
                ({m.workspace_members_you()})
              </span>
            )}
          </h2>
        </div>
        {profile.isViewer && (
          <Button
            size="sm"
            color="secondary"
            className="shrink-0"
            onPress={() =>
              void navigate({
                to: "/w/$workspaceSlug/settings",
                params: { workspaceSlug },
                search: { section: "account" },
              })
            }
          >
            {m.member_person_edit_profile()}
          </Button>
        )}
      </section>

      <section className="border-b border-secondary px-6 py-5">
        <p className={SECTION_CAPTION_CLASS}>{m.agent_profile_description()}</p>
        {profile.description.trim() ? (
          <p className="mt-2 text-sm whitespace-pre-wrap break-words text-secondary">
            {profile.description}
          </p>
        ) : (
          <p className="mt-2 text-sm text-quaternary italic">{m.member_person_no_description()}</p>
        )}
      </section>

      <section className="border-b border-secondary px-6 py-5">
        <p className={SECTION_CAPTION_CLASS}>{m.agent_profile_section_info()}</p>
        <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-4">
          <div>
            <dt className={SUBFIELD_LABEL_CLASS}>{m.agent_profile_role()}</dt>
            <dd className="mt-1">
              <Badge size="sm" color="gray">
                {workspaceRoleLabel(profile.role)}
              </Badge>
            </dd>
          </div>
          <div>
            <dt className={SUBFIELD_LABEL_CLASS}>{m.member_person_joined()}</dt>
            <dd className="mt-1 text-sm font-medium text-primary">
              <time className="tabular-nums" dateTime={new Date(profile.joinedAt).toISOString()}>
                {joinedOn}
              </time>
            </dd>
          </div>
          {profile.email && (
            <div className="col-span-2 min-w-0">
              <dt className={SUBFIELD_LABEL_CLASS}>{m.member_person_email()}</dt>
              <dd className="mt-1 truncate text-sm font-medium text-primary">
                <a
                  href={`mailto:${profile.email}`}
                  className="rounded-sm outline-focus-ring hover:underline focus-visible:outline-2"
                >
                  {profile.email}
                </a>
              </dd>
            </div>
          )}
        </dl>
      </section>

      <section className="px-6 py-5">
        <p className={SECTION_CAPTION_CLASS}>
          {m.member_created_agents()}
          <span className="ml-1.5 tabular-nums">{profile.createdAgents.length}</span>
        </p>
        {profile.createdAgents.length ? (
          <ul aria-label={m.member_created_agents()} className="mt-3 flex flex-col gap-2">
            {profile.createdAgents.map((agent) => (
              <li key={agent.id}>
                <Link
                  to="/w/$workspaceSlug/members"
                  params={{ workspaceSlug }}
                  resetScroll={false}
                  search={(previous) => ({
                    ...previous,
                    profile: formatAgentProfileParam(agent.id),
                  })}
                  aria-label={m.agent_open_profile({ name: agent.displayName })}
                  className="flex w-full min-w-0 items-center gap-3 rounded-lg px-3 py-2 text-left ring-1 ring-secondary outline-focus-ring ring-inset hover:bg-primary_hover focus-visible:outline-2"
                >
                  <CreatedAgentAvatar agent={agent} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-primary">
                      {agent.displayName}
                    </span>
                    {agent.description && (
                      <span className="block truncate text-xs text-tertiary">
                        {agent.description}
                      </span>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-quaternary italic">{m.member_person_no_agents()}</p>
        )}
      </section>
    </div>
  );
}

/** A created Agent's face with its live status, read from the shell's one Agent subscription. */
function CreatedAgentAvatar({ agent }: { agent: MemberPersonProfile["createdAgents"][number] }) {
  const display = useLiveAgentDisplay(agent.id);
  return <AgentDisplayAvatar name={agent.displayName} src={agent.avatarUrl} display={display} />;
}
