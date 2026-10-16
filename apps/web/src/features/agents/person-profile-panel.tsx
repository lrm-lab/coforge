import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useHydrated, useNavigate, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  AlertCircle,
  ArrowLeft,
  MessageSquare01 as MessageSquare,
  UserMinus01,
  UserX01,
  XClose as X,
} from "@untitledui/icons";
import { Button as AriaButton, Heading, Text } from "react-aria-components";

import { Dialog, Modal, ModalOverlay } from "#src/components/application/modals/modal";
import { FeaturedIcon } from "#src/components/foundations/featured-icon/featured-icon";
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
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { useOpenDirectConversation } from "#src/features/conversations/open-direct-conversation";
import { MemberAvatar } from "#src/features/workspaces/member-avatar";
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

/**
 * A person's right-hand panel (`profile=user:<id>`) on the Members page and in a conversation, the
 * human counterpart of `AgentProfilePanel`: who they are (name, description, email), their Workspace role and join
 * date, and the Agents they created that the viewer may see. Owners and admins change the
 * person's role and remove them here as in Settings → Members; a person edits their own profile
 * in Settings → Account.
 */
export function PersonProfilePanel({
  userId,
  onClose,
  back,
  onOpenAgent,
}: {
  userId: string;
  onClose: () => void;
  /** Where the profile was opened from, when it is shown inside another page (a channel's
   * members): a Back button before the avatar returns there. */
  back?: PanelBack;
  /** Opens one of the person's Agents in the host's own place for it. Absent, the Agent opens in
   * the page's profile slot through the address. */
  onOpenAgent?: (agentId: string) => void;
}) {
  // The app shell's Workspace, which every page hosting this panel sits under.
  const workspaceId = useCurrentWorkspaceId();
  const person = useQuery({
    ...memberPersonQuery(workspaceId ?? "", userId),
    enabled: workspaceId !== undefined,
  });
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
      {/* Same 48px band and 20px gutter as the Agent panel's header. */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-secondary px-5">
        {back && <BackButton back={back} />}
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
      className="-ml-1.5"
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
      className="-mr-1.5"
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
  /** The person was removed from the Workspace: the panel has nothing left to show. */
  onRemoved: () => void;
}) {
  const workspaceSlug = useWorkspaceSlug();
  const {
    changeRole,
    changingRole,
    roleError,
    remove,
    removeOpen,
    setRemoveOpen,
    removing,
    removeError,
  } = useMemberActions(profile, onRemoved);
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
        <p className="mt-2 text-sm whitespace-pre-wrap break-words text-secondary">
          {profile.description.trim() || "—"}
        </p>
      </section>

      <section className="border-b border-secondary px-6 py-5">
        <p className={SECTION_CAPTION_CLASS}>{m.agent_profile_section_info()}</p>
        {/* Short read-only facts: docs/design/field-display.md's fact list, label left and value
            right, with the one action on a fact at its row's end and its error under the row. */}
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
          <span className="ml-1.5 tabular-nums">{profile.createdAgents.length}</span>
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
                    // The page the panel is on (Members or a conversation) shows the Agent's panel
                    // in the same slot.
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
          <p className="mt-2 text-sm text-quaternary italic">{m.member_person_no_agents()}</p>
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
          <RemoveMemberDialog
            name={profile.displayName}
            open={removeOpen}
            busy={removing}
            error={removeError}
            onOpenChange={setRemoveOpen}
            onConfirm={remove}
          />
        </section>
      )}
    </div>
  );
}

/**
 * The owner/admin actions on a person, through the same writes Settings → Members uses (the
 * server re-checks who may do what). Each refreshes the Members directory and the page. A failure
 * stays inline where it happened (docs/design/toast-vs-inline.md): under the role row, or in the
 * remove dialog, which stays open so it can be tried again.
 */
function useMemberActions(profile: MemberPersonProfile, onRemoved: () => void) {
  const updateRole = useServerFn(updateWorkspaceMemberRole);
  const removeMember = useServerFn(removeWorkspaceMember);
  const queryClient = useQueryClient();
  const router = useRouter();
  const [changingRole, guardRole] = useSubmitGuard();
  const [roleError, setRoleError] = useState<string>();
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removing, guardRemove] = useSubmitGuard();
  const [removeError, setRemoveError] = useState<string>();
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
  const remove = () =>
    void guardRemove(async () => {
      setRemoveError(undefined);
      try {
        await removeMember({ data: { userId: profile.id } });
      } catch {
        setRemoveError(m.workspace_members_action_failed());
        return;
      }
      setRemoveOpen(false);
      onRemoved();
      await refresh();
    });
  const openRemove = (open: boolean) => {
    setRemoveError(undefined);
    setRemoveOpen(open);
  };
  return {
    changeRole,
    changingRole,
    roleError,
    remove,
    removeOpen,
    setRemoveOpen: openRemove,
    removing,
    removeError,
  };
}

/** One fact of the Info list: label left, value right, an optional action at the row's end, and
 * the action's error under the row (docs/design/field-display.md). */
function FactRow({
  label,
  help,
  children,
  action,
  error,
}: {
  label: string;
  /** On-demand help about the fact, beside its label. */
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
        <dd className="ml-auto min-w-0 truncate text-right text-sm text-tertiary">{children}</dd>
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

/** Confirms removing a person from the Workspace; the confirm is the dialog's one red button. */
function RemoveMemberDialog({
  name,
  open,
  busy,
  error,
  onOpenChange,
  onConfirm,
}: {
  name: string;
  open: boolean;
  busy: boolean;
  /** Why the last attempt failed; shown under the description. */
  error?: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <ModalOverlay isOpen={open} onOpenChange={(value) => !busy && onOpenChange(value)}>
      <Modal className="w-[calc(100vw-2rem)] max-w-md">
        <Dialog className="p-6">
          {({ close }) => (
            <>
              <div className="flex items-start gap-3">
                <FeaturedIcon color="error" theme="light" size="sm" icon={AlertCircle} />
                <div className="min-w-0 space-y-2">
                  <Heading
                    slot="title"
                    className="text-md font-semibold text-primary wrap-anywhere"
                  >
                    {m.member_person_remove_confirm_title({ name })}
                  </Heading>
                  <Text slot="description" className="text-sm text-secondary">
                    {m.member_person_remove_confirm_description()}
                  </Text>
                  {error && (
                    <p role="alert" className="text-sm text-error-primary">
                      {error}
                    </p>
                  )}
                </div>
              </div>
              <div className="mt-6 flex justify-end gap-3">
                <Button color="secondary" size="sm" isDisabled={busy} onPress={close}>
                  {m.controls_cancel()}
                </Button>
                <Button color="primary-destructive" size="sm" isLoading={busy} onPress={onConfirm}>
                  {m.member_person_remove()}
                </Button>
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
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

/** A created Agent's face with its live status, read from the shell's one Agent subscription. */
function CreatedAgentAvatar({ agent }: { agent: MemberPersonProfile["createdAgents"][number] }) {
  const display = useLiveAgentDisplay(agent.id);
  return <AgentDisplayAvatar name={agent.displayName} src={agent.avatarUrl} display={display} />;
}
