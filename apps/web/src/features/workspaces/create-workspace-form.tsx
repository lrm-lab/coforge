import { useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { Input } from "#src/components/base/input/input";
import { isAppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import { WORKSPACE_NAME_MAX_LENGTH } from "#src/features/workspaces/workspace.schemas";
import { createWorkspace } from "#src/features/workspaces/workspaces.functions";
import {
  isReservedWorkspaceSlug,
  isValidWorkspaceSlug,
  nameToWorkspaceSlug,
} from "#src/features/workspaces/workspace-slug";

export type CreateWorkspaceInput = { name: string; slug: string };

export function useCreateAndOpenWorkspace(): (input: CreateWorkspaceInput) => Promise<void> {
  const create = useServerFn(createWorkspace);
  const navigate = useNavigate();
  return async (input) => {
    const workspace = await create({ data: input });
    await navigate({
      to: "/w/$workspaceSlug",
      params: { workspaceSlug: workspace.slug },
    });
  };
}

export type CreateWorkspaceSubmit = {
  type: "submit";
  isDisabled: boolean;
  isLoading: boolean;
  showTextWhileLoading: true;
  children: string;
};

function slugProblem(slug: string): string {
  if (!slug) return "";
  if (!isValidWorkspaceSlug(slug)) return m.workspace_slug_invalid();
  if (isReservedWorkspaceSlug(slug)) return m.workspace_slug_reserved();
  return "";
}

function createProblem(cause: unknown): string {
  switch (isAppError(cause) ? cause.code : undefined) {
    case "CONFLICT":
      return m.workspace_slug_taken();
    case "INVALID_INPUT":
      return m.workspace_slug_invalid();
    default:
      return m.workspace_create_error();
  }
}

export function CreateWorkspaceForm({
  onCreate,
  fieldsClassName,
  actions,
}: {
  onCreate: (input: CreateWorkspaceInput) => Promise<void>;
  fieldsClassName?: string;
  actions: (submit: CreateWorkspaceSubmit) => ReactNode;
}) {
  const [name, setName] = useState("");
  const [editedSlug, setEditedSlug] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const slug = editedSlug ?? nameToWorkspaceSlug(name);
  const slugError = slugProblem(slug);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || !slug.trim() || slugError) return;
    setError("");
    setSubmitting(true);
    try {
      await onCreate({ name: name.trim(), slug: slug.trim() });
    } catch (cause) {
      setError(createProblem(cause));
    } finally {
      setSubmitting(false);
    }
  }

  const shownError = error || slugError;
  return (
    <form onSubmit={submit}>
      <div className={fieldsClassName}>
        <Input
          label={m.workspace_name_label()}
          name="name"
          isRequired
          maxLength={WORKSPACE_NAME_MAX_LENGTH}
          value={name}
          placeholder={m.workspace_name_placeholder()}
          onChange={setName}
        />
        <Input
          label={m.workspace_slug_label()}
          name="slug"
          isRequired
          value={slug}
          placeholder={m.workspace_slug_placeholder()}
          hint={shownError ? undefined : m.workspace_slug_hint()}
          isInvalid={Boolean(slugError)}
          onChange={setEditedSlug}
        />
        {shownError && (
          <p role="alert" className="text-sm text-error-primary">
            {shownError}
          </p>
        )}
      </div>
      {actions({
        type: "submit",
        isDisabled: Boolean(slugError),
        isLoading: submitting,
        showTextWhileLoading: true,
        children: submitting ? m.workspace_create_submitting() : m.workspace_create_submit(),
      })}
    </form>
  );
}
