import { useId, useMemo, useRef, useState, type FormEvent } from "react";
import { CHANNEL_NAME_PATTERN } from "@lrm/coforge-sdk/internal";
import { XClose } from "@untitledui/icons";
import { Heading, Text } from "react-aria-components";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import {
  UnsavedChangesDialog,
  useReportDirty,
  useUnsavedChangesGuard,
} from "#src/components/ui/unsaved-changes-dialog";
import {
  DialogAction,
  DialogActions,
  DialogCancel,
  useDialogControlSize,
} from "#src/components/ui/dialog-actions";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Checkbox } from "#src/components/base/checkbox/checkbox";
import { Input } from "#src/components/base/input/input";
import { Toggle } from "#src/components/base/toggle/toggle";
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
import { CHANNEL_VISIBILITY, type ChannelVisibility } from "./channel-visibility";
import { useWorkspaceDirectory } from "./workspace-directory-query";
import { GroupChatPicker } from "./group-chat-picker-list";

function initialKeys(initialMembers: CreateChannelDialogProps["initialMembers"]) {
  return new Set([
    ...(initialMembers?.humans ?? []).map((human) => `user:${human.id}`),
    ...(initialMembers?.agents ?? []).map((agent) => `agent:${agent.id}`),
  ]);
}

type CreateChannelDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (
    name: string,
    memberUserIds?: string[],
    memberAgentIds?: string[],
    visibility?: ChannelVisibility,
  ) => Promise<CreatedChannel | void>;
  onOpenChannel?: (channelId: string) => void | Promise<void>;
  defaultName?: string;
  initialMembers?: {
    humans: { id: string; displayName: string }[];
    agents: { id: string; displayName: string }[];
  };
  memberPicker?: boolean;
  minMembers?: number;
  offersPrivate?: boolean;
};

export function CreateChannelDialog({
  open,
  onOpenChange,
  onCreate,
  onOpenChannel,
  defaultName = "",
  initialMembers,
  memberPicker = false,
  minMembers = 0,
  offersPrivate = false,
}: CreateChannelDialogProps) {
  const directory = useWorkspaceDirectory({ enabled: memberPicker && open });
  const candidates = useMemo(
    () => (directory.data ? buildGroupChatCandidates(directory.data) : []),
    [directory.data],
  );
  const busy = useRef(false);
  const [dirty, setDirty] = useState(false);
  const guard = useUnsavedChangesGuard({
    overlayOpen: open,
    dirty,
    close: () => onOpenChange(false),
  });
  const form = {
    onCreate,
    onOpenChannel,
    onOpenChange,
    defaultName,
    initialMembers,
    minMembers,
    offersPrivate,
    candidates,
    directory,
    busy,
    onDirtyChange: setDirty,
  };
  return (
    <>
      <ModalOverlay
        isOpen={open}
        onOpenChange={(value) => {
          if (busy.current) return;
          if (value) onOpenChange(true);
          else guard.requestClose();
        }}
        className={memberPicker ? "max-md:px-0 max-md:[--modal-pb:0px]" : undefined}
      >
        {memberPicker ? (
          <Modal className="w-[calc(100vw-2rem)] max-w-4xl overflow-hidden max-md:h-full max-md:w-full max-md:rounded-b-none max-md:pb-safe-bottom">
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
      <UnsavedChangesDialog {...guard.promptProps} />
    </>
  );
}

type CreateChannelFormProps = Pick<
  CreateChannelDialogProps,
  | "onCreate"
  | "onOpenChannel"
  | "onOpenChange"
  | "defaultName"
  | "initialMembers"
  | "minMembers"
  | "offersPrivate"
> & {
  memberPicker: boolean;
  candidates: GroupChatCandidate[];
  directory: { isPending: boolean; isError: boolean; refetch: () => unknown };
  busy: { current: boolean };
  onDirtyChange: (dirty: boolean) => void;
  close: () => void;
};

function CreateChannelForm({
  onCreate,
  onOpenChannel,
  onOpenChange,
  defaultName = "",
  initialMembers,
  minMembers = 0,
  offersPrivate = false,
  memberPicker,
  candidates,
  directory,
  busy,
  onDirtyChange,
  close,
}: CreateChannelFormProps) {
  const controlSize = useDialogControlSize();
  const [name, setName] = useState(defaultName);
  const [makePrivate, setMakePrivate] = useState(false);
  const [startingKeys] = useState(() => initialKeys(initialMembers));
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(startingKeys);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
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
  const dirty =
    created === null &&
    (name !== defaultName ||
      makePrivate ||
      selectedKeys.size !== startingKeys.size ||
      [...selectedKeys].some((key) => !startingKeys.has(key)));
  useReportDirty(dirty, onDirtyChange);
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
        await onCreate(
          channelName,
          userIds,
          agentIds,
          makePrivate ? CHANNEL_VISIBILITY.PRIVATE : undefined,
        ),
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
      size={controlSize}
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
  const privateField = offersPrivate && (
    <Toggle
      label={m.channel_create_private()}
      isSelected={makePrivate}
      onChange={setMakePrivate}
      isDisabled={locked}
    />
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
        {!makePrivate && (
          <Text slot="description" className="mt-2 block text-sm text-tertiary">
            {m.channel_public_description()}
          </Text>
        )}
        <form onSubmit={(event) => void submit(event)} className="mt-5 flex flex-col gap-2">
          {nameField}
          {privateField}
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
  const finishButton = (size?: "sm") =>
    size ? (
      <Button
        type="submit"
        form={formId}
        size={size}
        isDisabled={locked || !nameValid || !canCreate}
      >
        {m.channel_group_finish()}
      </Button>
    ) : (
      <DialogAction type="submit" form={formId} isDisabled={locked || !nameValid || !canCreate}>
        {m.channel_group_finish()}
      </DialogAction>
    );
  if (!wide) {
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
            {privateField}
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
            {privateField}
            <ul className="flex flex-col gap-1">
              {selectedGroupChatCandidates(candidates, selectedKeys).map((entry) => (
                <li key={entry.key} className="flex items-center gap-3 py-1">
                  <ActorAvatar
                    presence
                    userId={entry.kind === "user" ? entry.id : undefined}
                    agentId={entry.kind === "agent" ? entry.id : undefined}
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
            <DialogActions className="mt-auto pt-2">
              <DialogCancel type="button" onPress={close}>
                {m.channel_members_cancel()}
              </DialogCancel>
              {finishButton()}
            </DialogActions>
          </form>
        )}
      </div>
    </>
  );
}
