import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Edit05 } from "@untitledui/icons";

import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { TextArea } from "#src/components/base/textarea/textarea";
import { useDialogControlSize } from "#src/components/ui/dialog-actions";
import { submitOnModEnter } from "#src/components/ui/dialog-form-keys";
import { isAppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import type { ChannelConversationView } from "./channel-conversation";
import { ChannelFace, ChannelTitle } from "./channel-name";
import { isPrivateChannel } from "./channel-visibility";
import { updatePublicChannelInfo } from "./channels.functions";
import { CHANNEL_DESCRIPTION_MAX_LENGTH, CHANNEL_NAME_MAX_LENGTH } from "./conversation.schemas";

export type InfoForm = ReturnType<typeof useInfoForm>;

export function useInfoForm(conversation: ChannelConversationView, onChanged: () => Promise<void>) {
  const update = useServerFn(updatePublicChannelInfo);
  const [name, setName] = useState(conversation.name);
  const [description, setDescription] = useState(conversation.description);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dirty =
    name.trim() !== conversation.name.trim() ||
    description.trim() !== conversation.description.trim();
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    if (dirtyRef.current) return;
    setName(conversation.name);
    setDescription(conversation.description);
  }, [conversation.name, conversation.description]);

  function edit(apply: () => void) {
    apply();
    setError("");
  }

  return {
    name,
    description,
    dirty,
    saving,
    error,
    setName: (value: string) => edit(() => setName(value)),
    setDescription: (value: string) => edit(() => setDescription(value)),
    reset() {
      setName(conversation.name);
      setDescription(conversation.description);
      setError("");
    },
    async save(): Promise<boolean> {
      if (!dirty) return true;
      setSaving(true);
      setError("");
      try {
        const trimmedName = name.trim();
        const trimmedDescription = description.trim();
        await update({
          data: {
            channelId: conversation.conversationId,
            ...(trimmedName !== conversation.name ? { name: trimmedName } : {}),
            ...(trimmedDescription !== conversation.description
              ? { description: trimmedDescription }
              : {}),
          },
        });
        await onChanged();
        setName(trimmedName);
        setDescription(trimmedDescription);
        return true;
      } catch (cause) {
        setError(infoSaveError(cause));
        return false;
      } finally {
        setSaving(false);
      }
    },
  };
}

function infoSaveError(cause: unknown) {
  if (!isAppError(cause)) return m.channel_settings_save_error();
  if (cause.code === "CONFLICT") return m.channel_conflict();
  if (cause.code === "INVALID_INPUT") return m.channel_name_hint();
  if (cause.code === "ACCESS_DENIED") return m.channel_settings_access_denied();
  return m.channel_settings_save_error();
}

export function ChannelIdentitySection({
  conversation,
  form,
  canEdit,
  editing,
  onStartEdit,
  onCancelEdit,
  onSaved,
}: {
  conversation: Pick<
    ChannelConversationView,
    "conversationId" | "name" | "visibility" | "description" | "archived"
  >;
  form: InfoForm;
  canEdit: boolean;
  editing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaved: () => void;
}) {
  const isGeneral = conversation.name === "general";
  const locked = conversation.archived || form.saving;
  const controlSize = useDialogControlSize();

  if (editing && canEdit && !conversation.archived) {
    return (
      <form
        onKeyDown={submitOnModEnter}
        className="flex flex-col gap-3.5"
        onSubmit={async (event) => {
          event.preventDefault();
          if (await form.save()) onSaved();
        }}
      >
        <Input
          size={controlSize}
          label={m.channel_settings_name()}
          placeholder={m.channel_settings_name_placeholder()}
          value={form.name}
          onChange={form.setName}
          isRequired
          maxLength={CHANNEL_NAME_MAX_LENGTH}
          isDisabled={isGeneral || locked}
          autoFocus={!isGeneral}
          hint={isGeneral ? m.channel_settings_general_cannot_rename() : m.channel_name_hint()}
        />
        <TextArea
          size={controlSize}
          label={m.channel_settings_description()}
          hint={m.channel_settings_description_hint()}
          placeholder={m.channel_settings_description_placeholder()}
          value={form.description}
          onChange={form.setDescription}
          maxLength={CHANNEL_DESCRIPTION_MAX_LENGTH}
          isDisabled={locked}
          rows={3}
          autoFocus={isGeneral}
        />
        {form.error && (
          <p role="alert" className="text-sm text-error-primary">
            {form.error}
          </p>
        )}
        <div className="flex items-center gap-2">
          <Button
            type="submit"
            size="sm"
            color="primary"
            isDisabled={!form.dirty || locked}
            isLoading={form.saving}
            showTextWhileLoading
          >
            {form.saving ? m.channel_settings_saving() : m.channel_settings_save()}
          </Button>
          <Button
            size="sm"
            color="tertiary"
            isDisabled={locked}
            onPress={() => {
              form.reset();
              onCancelEdit();
            }}
          >
            {m.channel_settings_cancel()}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <ChannelFace
            channelId={conversation.conversationId}
            className="avatar-group-xs"
            fallback={null}
          />
          <h3
            data-details-channel-name
            className="min-w-0 truncate text-md font-semibold text-primary"
          >
            <ChannelTitle
              name={conversation.name}
              visibility={conversation.visibility}
              hash={false}
            />
          </h3>
          {!isPrivateChannel(conversation) && (
            <Badge size="sm" color="gray" className="shrink-0">
              {m.channel_settings_public()}
            </Badge>
          )}
        </div>
        {canEdit && !conversation.archived && (
          <Button
            size="sm"
            color="tertiary"
            iconLeading={Edit05}
            className="shrink-0"
            onPress={onStartEdit}
          >
            {m.channel_settings_edit()}
          </Button>
        )}
      </div>
      {conversation.description && (
        <p className="whitespace-pre-wrap wrap-anywhere text-sm text-tertiary">
          {conversation.description}
        </p>
      )}
    </div>
  );
}
