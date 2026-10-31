import { useId, useMemo, useRef, useState, type FormEvent } from "react";
import { CHANNEL_NAME_PATTERN } from "@lrm/coforge-sdk/internal";
import { XClose } from "@untitledui/icons";
import { Heading, Text } from "react-aria-components";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { IdentityAvatar } from "#src/features/avatars/identity-avatar";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Checkbox } from "#src/components/base/checkbox/checkbox";
import { Input } from "#src/components/base/input/input";
import { Select } from "#src/components/base/select/select";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { isAppErrorCode } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import {
  buildGroupChatCandidates,
  canCreateGroupChat,
  selectedGroupChatCandidates,
  splitGroupChatKeys,
  toggleGroupChatKey,
  type GroupChatCandidate,
} from "./group-chat-picker";
import {
  createChannelOutcome,
  type CreatedChannel,
  type CreateChannelOutcome,
} from "./create-channel-outcome";
import { useWorkspaceDirectory } from "./workspace-directory-query";
import { GroupChatPicker } from "./group-chat-picker-list";

/** The `user:<id>` / `agent:<id>` keys an Agent-prepared card preselects. */
function initialKeys(initialMembers: CreateChannelDialogProps["initialMembers"]) {
  return new Set([
    ...(initialMembers?.humans ?? []).map((human) => `user:${human.id}`),
    ...(initialMembers?.agents ?? []).map((agent) => `agent:${agent.id}`),
  ]);
}

type CreateChannelDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Creates the channel. A resolved result says whether the picked members were added and the
   * Chat list re-read; a rejection means nothing was created. */
  onCreate: (
    name: string,
    projectId?: string,
    memberUserIds?: string[],
    memberAgentIds?: string[],
  ) => Promise<CreatedChannel | void>;
  /** Opens a channel the dialog created (the picker's result state and success). */
  onOpenChannel?: (channelId: string) => void | Promise<void>;
  projects?: { id: string; name: string; slug: string }[];
  /** Prefills, but does not force, the channel name — e.g. the project slug when
   * creating a project's first discussion group. */
  defaultName?: string;
  /** An Agent-prepared `channel:create` action card's initial humans/Agents: shown as
   * preselected, individually deselectable checkboxes. */
  initialMembers?: {
    humans: { id: string; displayName: string }[];
    agents: { id: string; displayName: string }[];
  };
  /** The two-pane group chat dialog: the Workspace's people and public Agents to pick from, beside
   * the name and project. Off, the dialog is the single column the other callers keep. */
  memberPicker?: boolean;
  /** With `memberPicker`, the fewest people (besides the creator) the channel may start with. */
  minMembers?: number;
};

export function CreateChannelDialog({
  open,
  onOpenChange,
  onCreate,
  onOpenChannel,
  projects = [],
  defaultName = "",
  initialMembers,
  memberPicker = false,
  minMembers = 0,
}: CreateChannelDialogProps) {
  const directory = useWorkspaceDirectory({ enabled: memberPicker && open });
  const candidates = useMemo(
    () => (directory.data ? buildGroupChatCandidates(directory.data) : []),
    [directory.data],
  );
  // A create in flight keeps the dialog from closing; the form below holds all other state and
  // mounts afresh on each opening, so a reopened dialog never shows the previous session.
  const busy = useRef(false);
  const form = {
    onCreate,
    onOpenChannel,
    onOpenChange,
    projects,
    defaultName,
    initialMembers,
    minMembers,
    candidates,
    directory,
    busy,
  };
  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={(value) => {
        if (!busy.current) onOpenChange(value);
      }}
      // On a phone the group chat dialog is Raft's sheet: edge to edge and down to the bottom.
      className={memberPicker ? "max-md:px-0 max-md:[--modal-pb:0px]" : undefined}
    >
      {memberPicker ? (
        // On a phone the sheet takes the screen's height, so the member list has room to fill
        // (task #331); side by side the panes share a fixed height.
        <Modal className="w-[calc(100vw-2rem)] max-w-4xl overflow-hidden max-md:h-full max-md:w-full max-md:rounded-b-none">
          <Dialog className="flex h-full flex-col p-0 md:h-[min(36rem,calc(100dvh-4rem))] md:flex-row">
            {({ close }) => <CreateChannelForm {...form} memberPicker close={close} />}
          </Dialog>
        </Modal>
      ) : (
        <Modal className="w-[calc(100vw-2rem)] max-w-md">
          <Dialog className="p-6">
            {({ close }) => <CreateChannelForm {...form} memberPicker={false} close={close} />}
          </Dialog>
        </Modal>
      )}
    </ModalOverlay>
  );
}

type CreateChannelFormProps = Pick<
  CreateChannelDialogProps,
  | "onCreate"
  | "onOpenChannel"
  | "onOpenChange"
  | "projects"
  | "defaultName"
  | "initialMembers"
  | "minMembers"
> & {
  memberPicker: boolean;
  candidates: GroupChatCandidate[];
  directory: { isPending: boolean; isError: boolean; refetch: () => unknown };
  busy: { current: boolean };
  close: () => void;
};

/** The dialog's content. Mounted per opening, so its name, search, selection and result start
 * from the dialog's own props each time. */
function CreateChannelForm({
  onCreate,
  onOpenChannel,
  onOpenChange,
  projects = [],
  defaultName = "",
  initialMembers,
  minMembers = 0,
  memberPicker,
  candidates,
  directory,
  busy,
  close,
}: CreateChannelFormProps) {
  const [name, setName] = useState(defaultName);
  const [projectId, setProjectId] = useState("");
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(() =>
    initialKeys(initialMembers),
  );
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  // Set once the channel exists: the dialog then only offers to open it, never to create it again.
  const [created, setCreated] = useState<{
    channelId: string;
    name: string;
    notice: "members" | "created";
  } | null>(null);
  const formId = useId();
  const wide = useBreakpoint("md");
  const nameValid = CHANNEL_NAME_PATTERN.test(name.trim());
  const canCreate = canCreateGroupChat(selectedKeys.size, minMembers);
  const locked = saving || created !== null;
  function toggle(key: string, on: boolean) {
    setSelectedKeys((previous) => toggleGroupChatKey(previous, key, on));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current || !canCreate || !nameValid) return;
    busy.current = true;
    setSaving(true);
    setError("");
    const channelName = name.trim();
    const { userIds, agentIds } = splitGroupChatKeys(selectedKeys);
    try {
      const outcome: CreateChannelOutcome = createChannelOutcome(
        await onCreate(channelName, projectId || undefined, userIds, agentIds),
      );
      if (outcome.kind === "open") {
        await onOpenChannel?.(outcome.channelId);
        onOpenChange(false);
      } else if (outcome.kind === "result") {
        setCreated({ channelId: outcome.channelId, name: channelName, notice: outcome.notice });
      } else {
        onOpenChange(false);
      }
    } catch (cause) {
      setError(isAppErrorCode(cause, "CONFLICT") ? m.channel_conflict() : m.channel_error());
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }
  const nameField = (
    <Input
      label={m.channel_name()}
      hint={m.channel_name_hint()}
      value={name}
      onChange={setName}
      isRequired
      maxLength={32}
      pattern="[a-z0-9][a-z0-9_\-]{0,31}"
      placeholder={m.channel_name_placeholder()}
      isDisabled={locked}
    />
  );
  // The group chat dialog always offers the field (a Workspace with no Project shows it disabled,
  // reading "No Project"); the single-column dialog keeps it only when there is a Project to pick.
  const projectField = (memberPicker || projects.length > 0) && (
    <Select
      aria-label={m.channel_project()}
      placeholder={m.channel_no_project()}
      selectedKey={projectId || null}
      onSelectionChange={(key) => setProjectId(String(key))}
      isDisabled={locked || projects.length === 0}
    >
      {projects.map((project) => (
        <Select.Item key={project.id} id={project.id} label={`${project.name} (${project.slug})`} />
      ))}
    </Select>
  );
  const errorText = error && (
    <p role="alert" className="text-sm text-error-primary">
      {error}
    </p>
  );
  const openButton = (
    <Button
      type="button"
      className="w-full"
      onPress={() => {
        if (!created) return;
        void (async () => {
          await onOpenChannel?.(created.channelId);
          onOpenChange(false);
        })();
      }}
    >
      {m.channel_open()}
    </Button>
  );
  const createdNotice = created && (
    <div className="flex flex-col gap-3">
      <p role="alert" className="text-sm text-error-primary">
        {created.notice === "members"
          ? m.channel_created_members_failed({ name: created.name })
          : m.channel_created({ name: created.name })}
      </p>
      {openButton}
    </div>
  );
  if (!memberPicker) {
    return (
      <>
        <ButtonUtility
          aria-label={m.controls_close()}
          icon={XClose}
          size="sm"
          color="tertiary"
          className="absolute top-4 right-4"
          onClick={close}
        />
        <Heading slot="title" className="pr-8 text-lg font-semibold text-primary">
          {m.channel_create()}
        </Heading>
        <Text slot="description" className="mt-2 block text-sm text-tertiary">
          {m.channel_public_description()}
        </Text>
        <form onSubmit={(event) => void submit(event)} className="mt-5 flex flex-col gap-2">
          {nameField}
          {projectField}
          {initialMembers &&
            (initialMembers.humans.length > 0 || initialMembers.agents.length > 0) && (
              <div className="mt-2 flex flex-col gap-2">
                <p className="text-xs font-medium text-tertiary">
                  {m.action_card_initial_members()}
                </p>
                {[
                  ...initialMembers.humans.map((human) => ({
                    key: `user:${human.id}`,
                    member: human,
                  })),
                  ...initialMembers.agents.map((agent) => ({
                    key: `agent:${agent.id}`,
                    member: agent,
                  })),
                ].map(({ key, member }) => (
                  <Checkbox
                    key={key}
                    label={`@${member.displayName}`}
                    isDisabled={locked}
                    isSelected={selectedKeys.has(key)}
                    onChange={(next) => toggle(key, next)}
                  />
                ))}
              </div>
            )}
          {errorText}
          <Button type="submit" isDisabled={locked || !nameValid} className="mt-4 w-full">
            {m.channel_create()}
          </Button>
        </form>
      </>
    );
  }
  const picker = (
    <GroupChatPicker
      candidates={candidates}
      search={search}
      onSearchChange={setSearch}
      selectedKeys={selectedKeys}
      onToggle={toggle}
      directory={directory}
      disabled={locked}
      framed={!wide}
    />
  );
  const minMembersHint = !canCreate && (
    <p className="text-sm text-tertiary">{m.channel_group_min_members({ count: minMembers })}</p>
  );
  const finishButton = (size?: "sm") => (
    <Button type="submit" form={formId} size={size} isDisabled={locked || !nameValid || !canCreate}>
      {m.channel_group_finish()}
    </Button>
  );
  if (!wide) {
    // A phone gets Raft's sheet: close, title and Finish along the top, then one column whose
    // member list takes what the fields leave (task #331).
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-secondary py-3 pr-4 pl-2">
          <ButtonUtility
            aria-label={m.controls_close()}
            icon={XClose}
            size="sm"
            color="tertiary"
            onClick={close}
          />
          <Heading
            slot="title"
            className="min-w-0 flex-1 truncate text-md font-semibold text-primary"
          >
            {m.channel_start_group()}
          </Heading>
          {!createdNotice && finishButton("sm")}
        </div>
        {createdNotice ? (
          <div className="p-4">{createdNotice}</div>
        ) : (
          <form
            id={formId}
            onSubmit={(event) => void submit(event)}
            className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4"
          >
            {nameField}
            {projectField}
            {errorText}
            {minMembersHint}
            <div className="flex min-h-48 flex-1 flex-col gap-3">{picker}</div>
          </form>
        )}
      </div>
    );
  }
  return (
    <>
      <aside className="flex min-h-0 w-[20rem] shrink-0 flex-col gap-3 border-r border-secondary bg-secondary p-4">
        {picker}
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-6">
        <ButtonUtility
          aria-label={m.controls_close()}
          icon={XClose}
          size="sm"
          color="tertiary"
          className="absolute top-4 right-4"
          onClick={close}
        />
        <div className="flex items-center justify-between gap-4 pr-8">
          <Heading slot="title" className="text-lg font-semibold text-primary">
            {m.channel_start_group()}
          </Heading>
          <p className="shrink-0 text-sm text-tertiary">
            {m.channel_group_selected_count({ count: selectedKeys.size })}
          </p>
        </div>
        {createdNotice ? (
          <div className="mt-5">{createdNotice}</div>
        ) : (
          <form
            id={formId}
            onSubmit={(event) => void submit(event)}
            className="mt-5 flex flex-1 flex-col gap-4"
          >
            {nameField}
            {projectField}
            <ul className="flex flex-col gap-1">
              {selectedGroupChatCandidates(candidates, selectedKeys).map((entry) => (
                <li key={entry.key} className="flex items-center gap-3 py-1">
                  <IdentityAvatar
                    size="xs"
                    alt=""
                    src={entry.avatarUrl ?? undefined}
                    name={entry.name}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-primary">
                    {entry.name}
                  </span>
                  <ButtonUtility
                    aria-label={m.channel_members_deselect({ name: entry.name })}
                    icon={XClose}
                    size="xs"
                    color="tertiary"
                    isDisabled={locked}
                    onClick={() => toggle(entry.key, false)}
                  />
                </li>
              ))}
            </ul>
            {minMembersHint}
            {errorText}
            <div className="mt-auto flex justify-end gap-3 pt-2">
              <Button type="button" color="secondary" onPress={close}>
                {m.channel_members_cancel()}
              </Button>
              {finishButton()}
            </div>
          </form>
        )}
      </div>
    </>
  );
}
