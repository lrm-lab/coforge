import { useState, type ReactNode } from "react";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { useHotkey } from "@tanstack/react-hotkeys";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useHydrated, useNavigate, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  ArrowLeft,
  MessageSquare01 as MessageSquare,
  UserMinus01,
  UserX01,
  XClose as X,
} from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";

import { MemberRemovalDialog } from "#src/features/workspaces/member-removal-dialog";
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
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { isAppErrorCode } from "#src/lib/app-error";
import { formatCalendarDate } from "#src/lib/dates";
import { formatNumber } from "#src/lib/format-number";
import { OPEN_OVERLAY_SELECTOR } from "#src/lib/open-overlay";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { useOpenDirectConversation } from "#src/features/conversations/open-direct-conversation";
import {
  removeWorkspaceMember,
  updateWorkspaceMemberRole,
} from "#src/features/workspaces/members.functions";
import { workspaceRoleLabel } from "#src/features/workspaces/workspace-role-label";
import { WorkspaceRoleHelp } from "#src/features/workspaces/workspace-role-help";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import type { MemberPersonProfile } from "#src/features/workspaces/workspaces.functions";
import { AgentDisplayAvatar } from "./agent-display-avatar";
import { MEMBER_DIRECTORY_KEY, memberPersonQuery } from "./member-directory-queries";
import { useCurrentWorkspaceId, useLiveAgentDisplay } from "./workspace-agents-realtime";
import { SECTION_CAPTION_CLASS } from "./profile-panel/inline-edit-field";
import { PanelMessage } from "./profile-panel/panel-message";
import { formatAgentProfileParam } from "./profile-panel/profile-panel-search";

const appRoute = getRouteApi("/w/$workspaceSlug");

export function PersonProfilePanel({
  userId,
  onClose,
  back,
  onOpenAgent,
  pageHeading = false,
}: {
  userId: string;
  onClose: () => void;
  back?: PanelBack;
  onOpenAgent?: (agentId: string) => void;
  pageHeading?: boolean;
}) {
  const Name = pageHeading ? "h1" : "p";
  const workspaceId = useCurrentWorkspaceId();
  const person = useQuery({
    ...memberPersonQuery(workspaceId ?? "", userId),
    enabled: workspaceId !== undefined,
  });
  const openDirectConversation = useOpenDirectConversation();
  useHotkey(
    "Escape",
    () => {
      if (document.querySelector(OPEN_OVERLAY_SELECTOR) === null) onClose();
    },
    { ignoreInputs: true, preventDefault: false },
  );

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
        <div className="flex h-12 shrink-0 items-center gap-2 px-5">
          {back && <BackButton back={back} />}
          <span className="flex-1" />
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
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-secondary px-5 any-pointer-coarse:gap-3">
        {back && <BackButton back={back} />}
        <ActorAvatar
          presence
          size="sm"
          userId={profile.id}
          name={profile.displayName}
          src={profile.avatarUrl}
        />
        <Name className="min-w-0 flex-1 truncate text-sm font-medium tracking-tight text-secondary">
          {profile.displayName}
        </Name>
        <ButtonUtility
          icon={MessageSquare}
          size="sm"
          tooltip={m.agent_profile_panel_message()}
          onClick={() => void openDirectConversation({ userId: profile.id })}
        />
        <CloseButton onClose={onClose} />
      </header>
      <PersonProfileBody profile={profile} onRemoved={onClose} onOpenAgent={onOpenAgent} />
    </aside>
  );
}

type PanelBack = { label: string; onPress: () => void };

function BackButton({ back }: { back: PanelBack }) {
  return (
    <ButtonUtility
      icon={ArrowLeft}
      size="sm"
      color="tertiary"
      className="-ms-1.5 [&_svg]:rtl:rotate-180"
      tooltip={back.label}
      aria-label={back.label}
      onClick={back.onPress}
    />
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <ButtonUtility
      icon={X}
      size="sm"
      color="tertiary"
      className="-me-1.5"
      tooltip={m.controls_close()}
      onClick={onClose}
    />
  );
}

function PersonProfileBody({
  profile,
  onRemoved,
  onOpenAgent,
}: {
  profile: MemberPersonProfile;
  onOpenAgent?: (agentId: string) => void;
  onRemoved: () => void;
}) {
  const workspaceSlug = useWorkspaceSlug();
  const { changeRole, changingRole, roleError, remove, removeOpen, setRemoveOpen } =
    useMemberActions(profile, onRemoved);
  const navigate = useNavigate();
  const timeZone = appRoute.useLoaderData().timeZone;
  const locale = getLocale();
  const hydrated = useHydrated();
  const joinedOn =
    timeZone || hydrated ? formatCalendarDate(profile.joinedAt, timeZone, locale) : "";

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <section className="flex items-center gap-4 border-b border-secondary px-6 py-5">
        <ActorAvatar
          presence
          size="xl"
          userId={profile.id}
          name={profile.displayName}
          src={profile.avatarUrl}
        />
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold wrap-anywhere text-primary">
            {profile.displayName}
            {profile.isViewer && (
              <span className="ms-1.5 text-sm font-normal text-tertiary">
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
        <p className="mt-2 text-sm whitespace-pre-wrap break-words text-secondary">
          {profile.description.trim() || "—"}
        </p>
      </section>

      <section className="border-b border-secondary px-6 py-5">
        <p className={SECTION_CAPTION_CLASS}>{m.agent_profile_section_info()}</p>
        <dl className="mt-2">
          <FactRow
            label={m.agent_profile_role()}
            help={<WorkspaceRoleHelp />}
            action={
              profile.canChangeRole && (
                <Button
                  size="sm"
                  color="secondary"
                  isLoading={changingRole}
                  onPress={() => changeRole(profile.role === "admin" ? "member" : "admin")}
                >
                  {profile.role === "admin"
                    ? m.workspace_member_make_member()
                    : m.workspace_member_make_admin()}
                </Button>
              )
            }
            error={roleError}
          >
            {workspaceRoleLabel(profile.role)}
          </FactRow>
          <FactRow label={m.member_person_joined()}>
            <time className="tabular-nums" dateTime={new Date(profile.joinedAt).toISOString()}>
              {joinedOn}
            </time>
          </FactRow>
          {profile.email && (
            <FactRow label={m.member_person_email()}>
              <a
                href={`mailto:${profile.email}`}
                className="rounded-sm outline-focus-ring hover:underline focus-visible:outline-2"
              >
                {profile.email}
              </a>
            </FactRow>
          )}
        </dl>
      </section>

      <section className="px-6 py-5">
        <p className={SECTION_CAPTION_CLASS}>
          {m.member_created_agents()}
          <span className="ms-1.5 tabular-nums">
            {formatNumber(profile.createdAgents.length, locale)}
          </span>
        </p>
        {profile.createdAgents.length ? (
          <ul aria-label={m.member_created_agents()} className="mt-3 flex flex-col gap-2">
            {profile.createdAgents.map((agent) => (
              <li key={agent.id}>
                {onOpenAgent ? (
                  <AriaButton
                    aria-label={m.agent_open_profile({ name: agent.displayName })}
                    className={CREATED_AGENT_ROW_CLASS}
                    onPress={() => onOpenAgent(agent.id)}
                  >
                    <CreatedAgentRow agent={agent} />
                  </AriaButton>
                ) : (
                  <Link
                    to="."
                    resetScroll={false}
                    search={(previous: { profile?: string; agentTab?: string }) => ({
                      ...previous,
                      profile: formatAgentProfileParam(agent.id),
                      agentTab: undefined,
                    })}
                    aria-label={m.agent_open_profile({ name: agent.displayName })}
                    className={CREATED_AGENT_ROW_CLASS}
                  >
                    <CreatedAgentRow agent={agent} />
                  </Link>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-quaternary">{m.member_person_no_agents()}</p>
        )}
      </section>

      {profile.canRemove && (
        <section className="border-t border-secondary px-6 py-5">
          <p className={SECTION_CAPTION_CLASS}>{m.agent_profile_section_actions()}</p>
          <Button
            size="sm"
            color="secondary-destructive"
            iconLeading={UserMinus01}
            className="mt-3"
            onPress={() => setRemoveOpen(true)}
          >
            {m.member_person_remove()}
          </Button>
          <MemberRemovalDialog
            open={removeOpen}
            onOpenChange={setRemoveOpen}
            userId={profile.id}
            name={profile.displayName}
            onConfirm={remove}
          />
        </section>
      )}
    </div>
  );
}

function useMemberActions(profile: MemberPersonProfile, onRemoved: () => void) {
  const updateRole = useServerFn(updateWorkspaceMemberRole);
  const removeMember = useServerFn(removeWorkspaceMember);
  const queryClient = useQueryClient();
  const router = useRouter();
  const [changingRole, guardRole] = useSubmitGuard();
  const [roleError, setRoleError] = useState<string>();
  const [removeOpen, setRemoveOpen] = useState(false);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: MEMBER_DIRECTORY_KEY }),
      router.invalidate({ sync: true }),
    ]);
  const changeRole = (role: "admin" | "member") =>
    void guardRole(async () => {
      setRoleError(undefined);
      try {
        await updateRole({ data: { userId: profile.id, role } });
      } catch {
        setRoleError(m.workspace_members_action_failed());
        return;
      }
      await refresh();
    });
  const remove = async () => {
    await removeMember({ data: { userId: profile.id } });
    setRemoveOpen(false);
    onRemoved();
    await refresh();
  };
  return {
    changeRole,
    changingRole,
    roleError,
    remove,
    removeOpen,
    setRemoveOpen,
  };
}

function FactRow({
  label,
  help,
  children,
  action,
  error,
}: {
  label: string;
  help?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  error?: string;
}) {
  return (
    <div className="border-b border-secondary py-1.5 last:border-b-0">
      <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1">
        <dt className="flex items-center gap-1 text-sm font-medium whitespace-nowrap text-primary">
          {label}
          {help}
        </dt>
        <dd className="ms-auto min-w-0 text-end text-sm wrap-anywhere text-tertiary">{children}</dd>
        {action}
      </div>
      {error && (
        <p role="alert" className="pb-1.5 text-sm text-error-primary">
          {error}
        </p>
      )}
    </div>
  );
}

const CREATED_AGENT_ROW_CLASS =
  "flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left ring-1 ring-secondary outline-focus-ring ring-inset hover:bg-primary_hover focus-visible:outline-2";

function CreatedAgentRow({ agent }: { agent: MemberPersonProfile["createdAgents"][number] }) {
  return (
    <>
      <CreatedAgentAvatar agent={agent} />
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-primary">
        {agent.displayName}
      </span>
    </>
  );
}

function CreatedAgentAvatar({ agent }: { agent: MemberPersonProfile["createdAgents"][number] }) {
  const display = useLiveAgentDisplay(agent.id);
  return (
    <AgentDisplayAvatar
      agentId={agent.id}
      name={agent.displayName}
      src={agent.avatarUrl}
      display={display}
    />
  );
}
