import { useEffect, useRef, useState } from "react";
import { useStore } from "@tanstack/react-form";
import { useServerFn } from "@tanstack/react-start";
import { CHANNEL_NAME_PATTERN } from "@lrm/coforge-sdk/internal";
import { Edit05 } from "@untitledui/icons";

import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { useDialogControlSize } from "#src/components/ui/dialog-actions";
import { submitOnModEnter } from "#src/components/ui/dialog-form-keys";
import { setFieldServerError, useAppForm } from "#src/components/ui/form";
import { isAppError } from "#src/lib/app-error";
import { scheduleFocusInvalidField } from "#src/lib/form-field-error";
import { m } from "#src/paraglide/messages";
import type { ChannelConversationView } from "./channel-conversation";
import { ChannelFace, ChannelTitle } from "./channel-name";
import { isPrivateChannel } from "./channel-visibility";
import { updatePublicChannelInfo } from "./channels.functions";
import { CHANNEL_DESCRIPTION_MAX_LENGTH, CHANNEL_NAME_MAX_LENGTH } from "./conversation.schemas";

export type InfoForm = ReturnType<typeof useInfoForm>;

export function useInfoForm(conversation: ChannelConversationView, onChanged: () => Promise<void>) {
  const update = useServerFn(updatePublicChannelInfo);
  const formRef = useRef<HTMLFormElement>(null);
  const saveOkRef = useRef(false);
  const [error, setError] = useState("");

  const appForm = useAppForm({
    defaultValues: {
      name: conversation.name,
      description: conversation.description,
    },
    onSubmitInvalid: () => scheduleFocusInvalidField(formRef.current),
    onSubmit: async ({ value }) => {
      const trimmedName = value.name.trim();
      const trimmedDescription = value.description.trim();
      if (
        trimmedName === conversation.name.trim() &&
        trimmedDescription === conversation.description.trim()
      ) {
        saveOkRef.current = true;
        return;
      }
      setError("");
      try {
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
        appForm.reset({ name: trimmedName, description: trimmedDescription });
        saveOkRef.current = true;
      } catch (cause) {
        const problem = infoSaveError(cause);
        if (problem.field === "name") {
          setFieldServerError(appForm, "name", problem.message, formRef.current);
        } else {
          setError(problem.message);
        }
      }
    },
  });

  const { name, description, saving } = useStore(appForm.store, (state) => ({
    name: state.values.name,
    description: state.values.description,
    saving: state.isSubmitting,
  }));
  const dirty =
    name.trim() !== conversation.name.trim() ||
    description.trim() !== conversation.description.trim();
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    if (dirtyRef.current) return;
    appForm.reset({ name: conversation.name, description: conversation.description });
  }, [appForm, conversation.name, conversation.description]);

  return {
    appForm,
    formRef,
    name,
    description,
    dirty,
    saving,
    error,
    clearError: () => setError(""),
    setName: (value: string) => {
      appForm.setFieldValue("name", value);
      setError("");
    },
    setDescription: (value: string) => {
      appForm.setFieldValue("description", value);
      setError("");
    },
    reset() {
      appForm.reset({ name: conversation.name, description: conversation.description });
      setError("");
    },
    async save(): Promise<boolean> {
      if (!dirty) return true;
      saveOkRef.current = false;
      await appForm.handleSubmit();
      return saveOkRef.current;
    },
  };
}

function infoSaveError(cause: unknown): { field?: "name"; message: string } {
  if (!isAppError(cause)) return { message: m.channel_settings_save_error() };
  if (cause.code === "CONFLICT") return { field: "name", message: m.channel_conflict() };
  if (cause.code === "INVALID_INPUT") return { field: "name", message: m.channel_name_hint() };
  if (cause.code === "ACCESS_DENIED") return { message: m.channel_settings_access_denied() };
  return { message: m.channel_settings_save_error() };
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
  const appForm = form.appForm;

  if (editing && canEdit && !conversation.archived) {
    return (
      <appForm.AppForm>
        <form
          ref={form.formRef}
          noValidate
          onKeyDown={submitOnModEnter}
          className="flex flex-col gap-3.5"
          onSubmit={async (event) => {
            event.preventDefault();
            if (await form.save()) onSaved();
          }}
        >
          <appForm.AppField
            name="name"
            validators={{
              onChange: ({ value }) =>
                !isGeneral && value.trim() && !CHANNEL_NAME_PATTERN.test(value.trim())
                  ? m.channel_name_hint()
                  : undefined,
              onSubmit: ({ value }) =>
                isGeneral || CHANNEL_NAME_PATTERN.test(value.trim())
                  ? undefined
                  : m.channel_name_hint(),
            }}
          >
            {(field) => (
              <field.Input
                size={controlSize}
                label={m.channel_settings_name()}
                placeholder={m.channel_settings_name_placeholder()}
                isRequired
                maxLength={CHANNEL_NAME_MAX_LENGTH}
                isDisabled={isGeneral || locked}
                autoFocus={!isGeneral}
                hint={
                  isGeneral ? m.channel_settings_general_cannot_rename() : m.channel_name_hint()
                }
                onChange={form.clearError}
              />
            )}
          </appForm.AppField>
          <appForm.AppField name="description">
            {(field) => (
              <field.TextArea
                size={controlSize}
                label={m.channel_settings_description()}
                hint={m.channel_settings_description_hint()}
                placeholder={m.channel_settings_description_placeholder()}
                maxLength={CHANNEL_DESCRIPTION_MAX_LENGTH}
                isDisabled={locked}
                rows={3}
                autoFocus={isGeneral}
                onChange={form.clearError}
              />
            )}
          </appForm.AppField>
          <appForm.Alert error={form.error} />
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
      </appForm.AppForm>
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
