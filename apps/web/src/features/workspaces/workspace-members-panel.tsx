import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  ArrowUpRight,
  Check,
  Copy01 as Copy,
  DotsVertical,
  SearchLg as Search,
  UserMinus01,
  UsersPlus,
} from "@untitledui/icons";

import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { Input } from "#src/components/base/input/input";
import { Select } from "#src/components/base/select/select";
import { useAppToast } from "#src/components/ui/toast";
import { MEMBER_DIRECTORY_KEY } from "#src/features/agents/member-directory-queries";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { formatNumber } from "#src/lib/format-number";
import { humanLabel } from "#src/lib/human-label";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { InviteMemberDialog } from "./invite-member-dialog";
import { createWorkspaceJoinLink, loadWorkspaceJoinLink } from "./join-links.functions";
import { MemberRemovalDialog } from "./member-removal-dialog";
import { removeWorkspaceMember, updateWorkspaceMemberRole } from "./members.functions";
import { WorkspaceRoleHelp } from "./workspace-role-help";
import { workspaceRoleLabel } from "./workspace-role-label";
import { canManageMembers } from "./workspace-roles";
import { useWorkspaceSlug } from "./workspace-route";

const COPIED_FEEDBACK_MS = 1_500;

type MemberRow = {
  userId: string;
  role: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
};

export function WorkspaceMembersPanel(props: {
  actorUserId: string;
  actorRole: string;
  members: MemberRow[];
  systemChannels?: ReactNode;
}) {
  const canManage = canManageMembers(props.actorRole);
  const workspaceSlug = useWorkspaceSlug();
  const locale = getLocale();
  const [search, setSearch] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [copyingLink, setCopyingLink] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [updatingRoleId, setUpdatingRoleId] = useState<string | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<{
    userId: string;
    name: string;
  }>();

  const updateRole = useServerFn(updateWorkspaceMemberRole);
  const remove = useServerFn(removeWorkspaceMember);
  const loadJoinLink = useServerFn(loadWorkspaceJoinLink);
  const createJoinLink = useServerFn(createWorkspaceJoinLink);
  const queryClient = useQueryClient();
  const router = useRouter();
  const toast = useAppToast();

  useEffect(() => {
    if (!copiedLink) return;
    const timer = setTimeout(() => setCopiedLink(false), COPIED_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copiedLink]);

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: MEMBER_DIRECTORY_KEY }),
      router.invalidate({ sync: true }),
    ]);
  }

  async function changeRole(userId: string, name: string, nextRole: "admin" | "member") {
    setUpdatingRoleId(userId);
    try {
      await updateRole({ data: { userId, role: nextRole } });
      await refresh();
    } catch {
      toast.error(m.workspace_member_role_failed({ name }));
    } finally {
      setUpdatingRoleId(null);
    }
  }

  async function copyInviteLink() {
    setCopyingLink(true);
    setCopyError(false);
    try {
      const link =
        (await loadJoinLink()) ??
        (await createJoinLink({ data: { maxUses: null, expiresAt: null } }));
      await navigator.clipboard.writeText(`${window.location.origin}/join/${link.token}`);
      setCopiedLink(true);
    } catch {
      setCopyError(true);
    } finally {
      setCopyingLink(false);
    }
  }

  const query = search.trim().toLowerCase();
  const visibleMembers = query
    ? props.members.filter((member) => humanLabel(member).toLowerCase().includes(query))
    : props.members;

  const roleOptions = [
    { id: "admin", label: workspaceRoleLabel("admin") },
    { id: "member", label: workspaceRoleLabel("member") },
  ];

  return (
    <div className="w-full px-page pb-8">
      <div className="divide-y divide-secondary border-b border-secondary">
        <section className="py-6">
          <header className="flex flex-wrap items-center justify-between gap-3 pb-4">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-primary">{m.workspace_members_title()}</h2>
              <span className="text-sm text-tertiary tabular-nums">
                {formatNumber(props.members.length, locale)}
              </span>
              <WorkspaceRoleHelp />
            </div>
            <Link
              to="/w/$workspaceSlug/members"
              params={{ workspaceSlug }}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-tertiary outline-focus-ring transition-colors hover:bg-primary_hover hover:text-primary focus-visible:outline-2"
            >
              <span>{m.workspace_members_open_directory()}</span>
              <ArrowUpRight aria-hidden="true" className="size-4" />
            </Link>
          </header>

          <div className="flex flex-wrap items-center gap-2 pb-4">
            <Input
              type="search"
              size="sm"
              icon={Search}
              aria-label={m.workspace_members_search()}
              placeholder={m.workspace_members_search()}
              value={search}
              onChange={setSearch}
              className="min-w-[12rem] flex-1"
            />
            {canManage && (
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  type="button"
                  color="primary"
                  size="sm"
                  iconLeading={copiedLink ? Check : Copy}
                  isLoading={copyingLink}
                  showTextWhileLoading
                  onPress={() => void copyInviteLink()}
                >
                  {copiedLink
                    ? m.workspace_members_invite_link_copied()
                    : m.workspace_members_copy_invite_link()}
                </Button>
                <Button
                  type="button"
                  color="secondary"
                  size="sm"
                  iconLeading={UsersPlus}
                  onPress={() => setInviteOpen(true)}
                >
                  {m.workspace_invite_button()}
                </Button>
              </div>
            )}
          </div>

          {copyError && (
            <p role="alert" className="pb-3 text-sm text-error-primary">
              {m.workspace_members_copy_link_failed()}
            </p>
          )}

          {visibleMembers.length > 0 ? (
            <ul
              aria-label={m.workspace_members_title()}
              className="divide-y divide-secondary border-t border-secondary"
            >
              {visibleMembers.map((member) => {
                const isSelf = member.userId === props.actorUserId;
                const displayName = humanLabel(member);
                const canEditRole = canManage && member.role !== "owner";
                const canRemove = canManage && member.role !== "owner" && !isSelf;

                return (
                  <li
                    key={member.userId}
                    className="flex min-h-12 items-center justify-between gap-3 py-2"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <ActorAvatar
                        presence
                        userId={member.userId}
                        size="sm"
                        name={displayName}
                        alt=""
                        src={member.avatarUrl}
                        className="shrink-0"
                      />
                      <div className="flex min-w-0 items-baseline gap-2">
                        <span className="truncate text-sm font-medium text-primary">
                          {displayName}
                        </span>
                        {isSelf && (
                          <span className="shrink-0 text-xs text-tertiary">
                            {m.workspace_members_you()}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {canEditRole ? (
                        <Select
                          aria-label={m.agent_profile_role()}
                          size="sm"
                          items={roleOptions}
                          selectedKey={member.role}
                          isDisabled={updatingRoleId === member.userId}
                          onSelectionChange={(key) => {
                            if ((key === "admin" || key === "member") && key !== member.role) {
                              void changeRole(member.userId, displayName, key);
                            }
                          }}
                          className="w-28"
                        >
                          {(item) => <Select.Item id={item.id} label={item.label} />}
                        </Select>
                      ) : (
                        <Badge size="sm" color="gray">
                          {workspaceRoleLabel(member.role)}
                        </Badge>
                      )}
                      {canRemove ? (
                        <Dropdown.Root>
                          <ButtonUtility
                            icon={DotsVertical}
                            size="sm"
                            color="tertiary"
                            tooltip={m.workspace_member_actions()}
                          />
                          <Dropdown.Popover placement="bottom end" className="w-44">
                            <Dropdown.Menu
                              aria-label={m.workspace_member_actions()}
                              onAction={(key) => {
                                if (key === "remove") {
                                  setRemoveTarget({
                                    userId: member.userId,
                                    name: displayName,
                                  });
                                  setRemoveOpen(true);
                                }
                              }}
                            >
                              <Dropdown.Item
                                id="remove"
                                icon={UserMinus01}
                                label={m.workspace_members_remove()}
                              />
                            </Dropdown.Menu>
                          </Dropdown.Popover>
                        </Dropdown.Root>
                      ) : canManage ? (
                        <span aria-hidden="true" className="w-8" />
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="flex items-center justify-between gap-3 border-t border-secondary py-6 text-sm text-tertiary">
              <span>{m.workspace_members_no_search_results()}</span>
              <Button size="sm" color="secondary" onPress={() => setSearch("")}>
                {m.agent_clear_search()}
              </Button>
            </div>
          )}
        </section>

        {props.systemChannels}
      </div>

      <InviteMemberDialog open={inviteOpen} onOpenChange={setInviteOpen} />
      <MemberRemovalDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        userId={removeTarget?.userId ?? ""}
        name={removeTarget?.name ?? ""}
        onConfirm={async () => {
          if (!removeTarget) return;
          await remove({ data: { userId: removeTarget.userId } });
          setRemoveOpen(false);
          await refresh();
        }}
      />
    </div>
  );
}
