import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Check, Share04 as Share } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { TextArea } from "#src/components/base/textarea/textarea";
import { Select } from "#src/components/base/select/select";
import { useAppToast } from "#src/components/ui/toast";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { projectsQuery } from "#src/features/projects/project-tree-queries";
import { isAppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import type { ChannelConversationView } from "./channel-conversation";
import { setPublicChannelProject, updatePublicChannelInfo } from "./channels.functions";

/** How long "Saved" stays beside the Info form's Save button. */
const SAVED_NOTICE_MS = 1500;

/** The Project picker's "No Project" option. */
const NO_PROJECT = "none";

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

/**
 * The Project the channel belongs to. A channel admin picks it here, changes it or sets it to none,
 * and it saves on the pick, as the coordinator does; anyone else reads it, with its repository
 * linked. The Workspace's Projects are read when the panel shows the field to an admin.
 */
export function ProjectField({
  conversation,
  canEdit,
  onChanged,
}: {
  conversation: ChannelConversationView;
  canEdit: boolean;
  onChanged: () => Promise<void>;
}) {
  const project = conversation.project;
  const workspaceId = useCurrentWorkspaceId();
  const projects = useQuery({
    ...projectsQuery(workspaceId ?? ""),
    enabled: canEdit && Boolean(workspaceId),
  }).data;
  const toast = useAppToast();
  const setProject = useServerFn(setPublicChannelProject);
  const [saving, setSaving] = useState(false);

  async function change(value: string) {
    if (value === (project?.id ?? NO_PROJECT)) return;
    setSaving(true);
    try {
      await setProject({
        data: {
          channelId: conversation.conversationId,
          projectId: value === NO_PROJECT ? null : value,
        },
      });
      await onChanged();
    } catch {
      toast.error(m.channel_settings_project_error());
    } finally {
      setSaving(false);
    }
  }

  const repository = project?.githubHtmlUrl && project.githubFullName && (
    <a
      href={project.githubHtmlUrl}
      target="_blank"
      rel="noreferrer"
      aria-label={m.channel_settings_view_repository({ repository: project.githubFullName })}
      className="inline-flex min-w-0 items-center gap-1 text-sm text-brand-secondary hover:underline"
    >
      <span className="truncate">{project.githubFullName}</span>
      <Share aria-hidden="true" className="size-3.5 shrink-0" />
    </a>
  );

  if (!canEdit) {
    if (!project) return null;
    return (
      <div className="mt-4 first:mt-0">
        <p className="text-sm text-tertiary">{m.channel_settings_project()}</p>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="truncate font-medium text-primary">{project.name}</span>
          {repository}
        </div>
      </div>
    );
  }
  // Under the name form a rule sets it apart: it saves on pick, not with the form's Save.
  return (
    <div className="mt-5 flex flex-col gap-1.5 border-t border-secondary pt-5 first:mt-0 first:border-t-0 first:pt-0">
      <Select
        label={m.channel_settings_project()}
        selectedKey={project?.id ?? NO_PROJECT}
        isDisabled={saving || !projects}
        onSelectionChange={(key) => {
          if (key !== null) void change(String(key));
        }}
      >
        <Select.Item id={NO_PROJECT} label={m.channel_no_project()} />
        {/* The current Project stays listed while the Workspace's are still being read. */}
        {(projects ?? (project ? [project] : [])).map((candidate) => (
          <Select.Item key={candidate.id} id={candidate.id} label={candidate.name} />
        ))}
      </Select>
      {repository && <div>{repository}</div>}
    </div>
  );
}
