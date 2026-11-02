import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Check, Share04 as Share } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { TextArea } from "#src/components/base/textarea/textarea";
import { isAppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import type { ChannelConversationView } from "./channel-conversation";
import { updatePublicChannelInfo } from "./channels.functions";

/** How long "Saved" stays beside the Info form's Save button. */
const SAVED_NOTICE_MS = 1500;

/*
 * The channel settings panel's Info section: the name-and-description form channel admins edit,
 * and the Project the channel belongs to.
 */

export type InfoForm = ReturnType<typeof useInfoForm>;

/** The Info form's draft and save state. The draft follows the channel until it is edited, so a
 * rename made elsewhere shows up here while nothing is being typed. */
export function useInfoForm(conversation: ChannelConversationView, onChanged: () => Promise<void>) {
  const update = useServerFn(updatePublicChannelInfo);
  const [name, setName] = useState(conversation.name);
  const [description, setDescription] = useState(conversation.description);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Compare normalized values on both sides. Channel values can carry incidental surrounding
  // whitespace from older edits; that must not make a freshly opened form look dirty.
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
  useEffect(() => () => clearTimeout(savedTimer.current), []);

  function edit(apply: () => void) {
    apply();
    setError("");
    setSaved(false);
  }

  return {
    name,
    description,
    dirty,
    saving,
    saved,
    error,
    setName: (value: string) => edit(() => setName(value)),
    setDescription: (value: string) => edit(() => setDescription(value)),
    reset() {
      setName(conversation.name);
      setDescription(conversation.description);
      setError("");
    },
    /** Resolves `true` once the channel holds the draft. */
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
        setSaved(true);
        clearTimeout(savedTimer.current);
        savedTimer.current = setTimeout(() => setSaved(false), SAVED_NOTICE_MS);
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

export function InfoForm({
  form,
  channelName,
  archived,
}: {
  form: InfoForm;
  channelName: string;
  /** An archived channel's name and description are frozen until it is unarchived. */
  archived: boolean;
}) {
  const isGeneral = channelName === "general";
  const locked = archived || form.saving;
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void form.save();
      }}
    >
      <Input
        label={m.channel_settings_name()}
        placeholder={m.channel_settings_name_placeholder()}
        value={form.name}
        onChange={form.setName}
        isRequired
        isDisabled={isGeneral || locked}
        hint={isGeneral ? m.channel_settings_general_cannot_rename() : m.channel_name_hint()}
      />
      <TextArea
        label={m.channel_settings_description()}
        placeholder={m.channel_settings_description_placeholder()}
        value={form.description}
        onChange={form.setDescription}
        isDisabled={locked}
        rows={2}
      />
      {form.error && (
        <p role="alert" className="text-sm text-error-primary">
          {form.error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button size="sm" color="secondary" isDisabled={!form.dirty || locked} onPress={form.reset}>
          {m.channel_settings_cancel()}
        </Button>
        <Button
          type="submit"
          size="sm"
          iconLeading={form.saved ? Check : undefined}
          isDisabled={!form.dirty || locked}
          isLoading={form.saving}
          showTextWhileLoading
        >
          {form.saving
            ? m.channel_settings_saving()
            : form.saved
              ? m.channel_settings_saved()
              : m.channel_settings_save()}
        </Button>
      </div>
      <span role="status" aria-live="polite" className="sr-only">
        {form.saved ? m.channel_settings_saved() : ""}
      </span>
    </form>
  );
}

export function ProjectField({
  project,
}: {
  project: NonNullable<ChannelConversationView["project"]>;
}) {
  return (
    <div className="mt-4 first:mt-0">
      <p className="text-sm text-tertiary">{m.channel_settings_project()}</p>
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="truncate font-medium text-primary">{project.name}</span>
        {project.githubHtmlUrl && project.githubFullName && (
          <a
            href={project.githubHtmlUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={m.channel_settings_view_repository({ repository: project.githubFullName })}
            className="inline-flex min-w-0 items-center gap-1 text-brand-secondary hover:underline"
          >
            <span className="truncate">{project.githubFullName}</span>
            <Share aria-hidden="true" className="size-3.5 shrink-0" />
          </a>
        )}
      </div>
    </div>
  );
}
