import { GridListItem } from "react-aria-components";
import { Link, useNavigate } from "@tanstack/react-router";
import { Archive, Calendar, DotsVertical, Edit01, Monitor01 as Monitor } from "@untitledui/icons";
import { IdentityAvatar } from "#src/features/avatars/identity-avatar";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { MemberAvatar } from "#src/features/workspaces/member-avatar";
import { useMemberOnline } from "#src/features/workspaces/member-presence";
import type { MemberAgent, MemberPerson } from "#src/features/workspaces/workspaces.functions";
import { useOpenDirectConversation } from "#src/features/conversations/open-direct-conversation";
import {
  formatAgentProfileParam,
  formatPersonProfileParam,
} from "./profile-panel/profile-panel-search";
import { AgentDisplayAvatar, AgentStackFace } from "./agent-display-avatar";
import type { AgentView } from "./agents-content";

type DirectoryAgent = MemberAgent;
type DirectoryPerson = MemberPerson;

const CARD_CLASS =
  "flex min-w-0 flex-col gap-2.5 rounded-xl bg-primary p-4 shadow-xs ring-1 ring-secondary outline-focus-ring ring-inset data-focus-visible:outline-2 data-focus-visible:outline-offset-2";

export function PersonCard({ person, selected }: { person: DirectoryPerson; selected: boolean }) {
  const { total, items } = person.createdAgents;
  const more = total - items.length;
  const online = useMemberOnline(person.id);
  const openDirectConversation = useOpenDirectConversation();
  const workspaceSlug = useWorkspaceSlug();
  return (
    <GridListItem
      id={person.id}
      textValue={person.displayName}
      className={cn(CARD_CLASS, selected && "ring-2 ring-brand")}
    >
      <div className="flex items-start justify-between gap-3">
        <MemberAvatar
          size="lg"
          userId={person.id}
          name={person.displayName}
          src={person.avatarUrl}
        />
        {/* Every member card offers it, the viewer's own too: that opens their DM with themself. */}
        <div className="flex min-h-9 shrink-0 items-center">
          <Button
            size="sm"
            color="secondary"
            onPress={() => void openDirectConversation({ userId: person.id })}
          >
            {m.member_private_chat()}
          </Button>
        </div>
      </div>
      <div className="min-w-0">
        <h2 className="truncate text-md font-semibold text-primary">
          <Link
            to="/w/$workspaceSlug/members"
            params={{ workspaceSlug }}
            resetScroll={false}
            search={(previous) => ({
              ...previous,
              profile: formatPersonProfileParam(person.id),
              agentTab: undefined,
            })}
            aria-label={m.member_person_open_profile({ name: person.displayName })}
            aria-current={selected ? "page" : undefined}
            className="inline-flex min-h-11 items-center rounded-sm outline-focus-ring outline-offset-4 hover:underline focus-visible:outline-2 sm:min-h-0"
          >
            {person.displayName}
          </Link>
          {online !== undefined && (
            <span className="sr-only">, {online ? m.member_online() : m.member_offline()}</span>
          )}
        </h2>
      </div>
      {/* Fixed two-line slot, as on Agent cards, so a row's footers line up. */}
      <p className="line-clamp-2 min-h-10 text-sm break-words text-secondary">
        {person.description}
      </p>
      {total > 0 && (
        <div className="mt-auto flex justify-end pt-1">
          <Tooltip title={m.member_created_agents_tooltip()} arrow>
            <TooltipTrigger className="flex cursor-default items-center -space-x-1.5 rounded-full outline-focus-ring focus-visible:outline-2">
              <span className="sr-only">{m.member_created_agents_count({ count: total })}</span>
              {items.map((agent) => (
                <AgentStackFace key={agent.id} agent={agent} />
              ))}
              {more > 0 && (
                <IdentityAvatar
                  size="xs"
                  alt=""
                  initials={`+${more}`}
                  className="ring-2 ring-bg-primary"
                />
              )}
            </TooltipTrigger>
          </Tooltip>
        </div>
      )}
    </GridListItem>
  );
}

export function AgentCard({
  member,
  ownedAgent,
  selected,
  createdOn,
  canEdit,
  onDelete,
}: {
  member: DirectoryAgent;
  ownedAgent?: AgentView;
  selected: boolean;
  createdOn: string;
  canEdit: boolean;
  /** Present only for a viewer who may delete Agents. */
  onDelete?: () => void;
}) {
  const navigate = useNavigate();
  const openDirectConversation = useOpenDirectConversation();
  const workspaceSlug = useWorkspaceSlug();
  // Editing happens in the profile panel's Profile tab.
  const openProfileToEdit = () =>
    void navigate({
      to: "/w/$workspaceSlug/members",
      params: { workspaceSlug },
      resetScroll: false,
      search: (previous) => ({
        ...previous,
        profile: formatAgentProfileParam(member.id),
        agentTab: "profile",
      }),
    });

  return (
    <GridListItem
      id={member.id}
      textValue={member.displayName}
      className={cn(CARD_CLASS, selected && "ring-2 ring-brand")}
    >
      <div className="flex items-start justify-between gap-3">
        {ownedAgent ? (
          <AgentDisplayAvatar
            agentId={member.id}
            name={member.displayName}
            src={member.avatarUrl}
            display={ownedAgent.display}
            size="lg"
          />
        ) : (
          <IdentityAvatar
            size="lg"
            alt={member.displayName}
            src={member.avatarUrl ?? undefined}
            name={member.displayName}
          />
        )}
        <div className="flex min-h-9 shrink-0 items-center gap-1">
          {member.canMessage && (
            <Button
              size="sm"
              color="secondary"
              onPress={() => void openDirectConversation({ agentId: member.id })}
            >
              {m.agent_private_chat()}
            </Button>
          )}
          <Dropdown.Root>
            <ButtonUtility
              icon={DotsVertical}
              size="sm"
              color="tertiary"
              tooltip={m.member_agent_actions({ name: member.displayName })}
              // Greyed out, per design, if the viewer may neither edit nor delete.
              isDisabled={!canEdit && !onDelete}
            />
            <Dropdown.Popover placement="bottom end" className="w-44">
              <Dropdown.Menu
                onAction={(key) => {
                  if (key === "edit") openProfileToEdit();
                  if (key === "delete") onDelete?.();
                }}
              >
                {canEdit ? <Dropdown.Item id="edit" icon={Edit01} label={m.agent_edit()} /> : null}
                {onDelete ? (
                  // A destructive menu item is red text (docs/design/color-status-typography.md);
                  // the official item colours its label and icon grey, so both go in as children.
                  <Dropdown.Item id="delete" textValue={m.member_agent_delete()}>
                    <span className="flex items-center text-error-primary">
                      <Archive
                        aria-hidden="true"
                        className="mr-2 size-4 shrink-0 stroke-[2.25px]"
                      />
                      {m.member_agent_delete()}
                    </span>
                  </Dropdown.Item>
                ) : null}
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown.Root>
        </div>
      </div>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <h2 className="min-w-0 truncate text-md font-semibold text-primary">
            <Link
              to="/w/$workspaceSlug/members"
              params={{ workspaceSlug }}
              resetScroll={false}
              search={(previous) => ({
                ...previous,
                profile: formatAgentProfileParam(member.id),
              })}
              aria-label={m.agent_open_profile({ name: member.displayName })}
              aria-current={selected ? "page" : undefined}
              className="inline-flex min-h-11 items-center rounded-sm outline-focus-ring outline-offset-4 hover:underline focus-visible:outline-2 sm:min-h-0"
            >
              {member.displayName}
            </Link>
          </h2>
          <span className="flex max-w-[55%] min-w-0 shrink-0 items-center gap-1.5 rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium text-tertiary ring-1 ring-secondary ring-inset">
            <Monitor aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="truncate">
              {member.computerId === null
                ? m.member_no_computer()
                : member.computerName || m.agent_computer_unnamed()}
            </span>
          </span>
        </div>
        <p className="truncate text-sm text-tertiary">@{member.name}</p>
      </div>
      {/* Fixed two-line slot so every card in a row lines its footer up. */}
      <p className="line-clamp-2 min-h-10 text-sm break-words text-secondary">
        {member.description}
      </p>
      <div className="mt-auto flex min-w-0 items-center gap-4 pt-1 text-sm text-tertiary">
        <Tooltip title={m.member_created_by()} arrow>
          <TooltipTrigger className="flex min-w-0 cursor-default items-center gap-2 rounded-sm outline-focus-ring focus-visible:outline-2">
            <IdentityAvatar
              size="xs"
              alt=""
              src={member.owner.avatarUrl ?? undefined}
              name={member.owner.displayName}
            />
            <span className="sr-only">{m.member_created_by()}</span>
            <span className="truncate">{member.owner.displayName}</span>
          </TooltipTrigger>
        </Tooltip>
        <Tooltip title={m.member_created_on()} arrow>
          <TooltipTrigger className="flex shrink-0 cursor-default items-center gap-1.5 rounded-sm outline-focus-ring focus-visible:outline-2">
            <Calendar aria-hidden="true" className="size-4 text-fg-quaternary" />
            <span className="sr-only">{m.member_created_on()}</span>
            <time className="tabular-nums" dateTime={new Date(member.createdAt).toISOString()}>
              {createdOn}
            </time>
          </TooltipTrigger>
        </Tooltip>
      </div>
    </GridListItem>
  );
}
