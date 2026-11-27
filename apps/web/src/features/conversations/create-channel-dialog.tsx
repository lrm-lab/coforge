import { useId, useMemo, useRef, useState } from "react";
import { useStore } from "@tanstack/react-form";
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
import { setFieldServerError, useAppForm } from "#src/components/ui/form";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Checkbox } from "#src/components/base/checkbox/checkbox";
import { Toggle } from "#src/components/base/toggle/toggle";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { PhoneFormBar } from "#src/components/ui/phone-form-bar";
import { isAppErrorCode } from "#src/lib/app-error";
import { scheduleFocusInvalidField } from "#src/lib/form-field-error";
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
    agents: { id: string; name?: string; displayName: string }[];
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
        page={!memberPicker}
        className={
          memberPicker
            ? "max-md:items-stretch max-md:px-0 max-md:[--modal-pb:0px] max-md:[--modal-pt:0px]"
            : undefined
        }
      >
        {memberPicker ? (
          <Modal className="w-[calc(100vw-2rem)] max-w-4xl overflow-hidden max-md:h-full max-md:w-full max-md:rounded-none max-md:ring-0 max-md:safe-area-padding">
            <Dialog className="flex h-full flex-col p-0 md:h-[min(36rem,calc(100dvh-4rem))] md:flex-row">
              {({ close }) => <CreateChannelForm {...form} memberPicker close={close} />}
            </Dialog>
          </Modal>
        ) : (
          <Modal className="w-[calc(100vw-2rem)] max-w-md">
            <Dialog className="p-6 max-sm:flex max-sm:h-full max-sm:flex-col max-sm:p-0">
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
  const [startingKeys] = useState(() => initialKeys(initialMembers));
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(startingKeys);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{
    channelId: string;
    name: string;
    notice: "members" | "created";
  } | null>(null);
  const formId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const wide = useBreakpoint("md");
  const canCreate = canCreateGroupChat(selectedKeys.size, minMembers);

  const form = useAppForm({
    defaultValues: { name: defaultName, makePrivate: false },
    onSubmitInvalid: () => scheduleFocusInvalidField(formRef.current),
    onSubmit: async ({ value }) => {
      if (busy.current || !canCreate) return;
      busy.current = true;
      setError("");
      const channelName = value.name.trim();
      const { userIds, agentIds } = splitGroupChatKeys(selectedKeys);
      try {
        const outcome: CreateChannelOutcome = createChannelOutcome(
          await onCreate(
            channelName,
            userIds,
            agentIds,
            value.makePrivate ? CHANNEL_VISIBILITY.PRIVATE : undefined,
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
        if (isAppErrorCode(cause, "CONFLICT")) {
          setFieldServerError(form, "name", m.channel_conflict(), formRef.current);
        } else if (isAppErrorCode(cause, "INVALID_INPUT")) {
          setFieldServerError(form, "name", m.channel_name_hint(), formRef.current);
        } else {
          setError(m.channel_error());
        }
      } finally {
        busy.current = false;
      }
    },
  });

  const { name, makePrivate, saving } = useStore(form.store, (state) => ({
    name: state.values.name,
    makePrivate: state.values.makePrivate,
    saving: state.isSubmitting,
  }));
  const nameValid = CHANNEL_NAME_PATTERN.test(name.trim());
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
  const nameField = (
    <form.AppField
      name="name"
      validators={{
        onChange: ({ value }) =>
          value.trim() && !CHANNEL_NAME_PATTERN.test(value.trim())
            ? m.channel_name_hint()
            : undefined,
        onSubmit: ({ value }) =>
          CHANNEL_NAME_PATTERN.test(value.trim()) ? undefined : m.channel_name_hint(),
      }}
    >
      {(field) => (
        <field.Input
          size={controlSize}
          label={m.channel_name()}
          hint={m.channel_name_hint()}
          onChange={() => setError("")}
          isRequired
          maxLength={32}
          pattern="[a-z0-9][a-z0-9_\-]{0,31}"
          placeholder={m.channel_name_placeholder()}
          isDisabled={locked}
        />
      )}
    </form.AppField>
  );
  const privateField = offersPrivate && (
    <form.AppField name="makePrivate">
      {(field) => (
        <Toggle
          label={m.channel_create_private()}
          isSelected={field.state.value}
          onChange={field.handleChange}
          isDisabled={locked}
        />
      )}
    </form.AppField>
  );
  const errorText = <form.Alert error={error} />;
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
      <form.AppForm>
        <PhoneFormBar
          heading={m.channel_create()}
          submitLabel={m.controls_create()}
          pending={saving}
          submitDisabled={locked || !nameValid}
          onCancel={close}
          onSubmit={() => formRef.current?.requestSubmit()}
        />
        <ButtonUtility
          aria-label={m.controls_close()}
          icon={XClose}
          size="sm"
          color="tertiary"
          className="absolute top-4 right-4 max-sm:hidden"
          onClick={close}
        />
        <Heading slot="title" className="pr-8 text-lg font-semibold text-primary max-sm:sr-only">
          {m.channel_create()}
        </Heading>
        {!makePrivate && (
          <Text
            slot="description"
            className="mt-2 block text-sm text-tertiary max-sm:mt-0 max-sm:px-4 max-sm:pt-4"
          >
            {m.channel_public_description()}
          </Text>
        )}
        <form
          id={formId}
          ref={formRef}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
          className="mt-5 flex flex-col gap-2 max-sm:mt-0 max-sm:min-h-0 max-sm:flex-1 max-sm:overflow-y-auto max-sm:p-4"
        >
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
                    label: human.displayName,
                  })),
                  ...initialMembers.agents.map((agent) => ({
                    key: `agent:${agent.id}`,
                    label: `@${agent.name ?? agent.displayName}`,
                  })),
                ].map(({ key, label }) => (
                  <Checkbox
                    key={key}
                    label={label}
                    isDisabled={locked}
                    isSelected={selectedKeys.has(key)}
                    onChange={(next) => toggle(key, next)}
                  />
                ))}
              </div>
            )}
          {errorText}
          <Button
            type="submit"
            isDisabled={locked || !nameValid}
            className="mt-4 w-full max-sm:hidden"
          >
            {m.channel_create()}
          </Button>
        </form>
      </form.AppForm>
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
  const finishButton = () => (
    <DialogAction type="submit" form={formId} isDisabled={locked || !nameValid || !canCreate}>
      {m.channel_group_finish()}
    </DialogAction>
  );
  if (!wide) {
    return (
      <form.AppForm>
        <div className="flex min-h-0 flex-1 flex-col">
          <Heading slot="title" className="sr-only">
            {m.channel_start_group()}
          </Heading>
          <PhoneFormBar
            className="sm:grid"
            heading={m.channel_start_group()}
            submitLabel={m.channel_group_finish()}
            pending={saving}
            submitDisabled={locked || !nameValid || !canCreate}
            onCancel={close}
            onSubmit={() => formRef.current?.requestSubmit()}
          />
          {createdNotice ? (
            <div className="p-4">{createdNotice}</div>
          ) : (
            <form
              id={formId}
              ref={formRef}
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void form.handleSubmit();
              }}
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
      </form.AppForm>
    );
  }
  return (
    <form.AppForm>
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
            ref={formRef}
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void form.handleSubmit();
            }}
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
    </form.AppForm>
  );
}
