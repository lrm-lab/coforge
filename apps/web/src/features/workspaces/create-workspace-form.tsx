import { useRef, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { setFieldServerError, useAppForm } from "#src/components/ui/form";
import { isAppError } from "#src/lib/app-error";
import { scheduleFocusInvalidField } from "#src/lib/form-field-error";
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

function slugProblem(slug: string): string | undefined {
  if (!slug) return undefined;
  if (!isValidWorkspaceSlug(slug)) return m.workspace_slug_invalid();
  if (isReservedWorkspaceSlug(slug)) return m.workspace_slug_reserved();
  return undefined;
}

function createProblem(cause: unknown): { field?: "slug"; message: string } {
  switch (isAppError(cause) ? cause.code : undefined) {
    case "CONFLICT":
      return { field: "slug", message: m.workspace_slug_taken() };
    case "INVALID_INPUT":
      return { field: "slug", message: m.workspace_slug_invalid() };
    default:
      return { message: m.workspace_create_error() };
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
  const formRef = useRef<HTMLFormElement>(null);
  const slugEdited = useRef(false);
  const [formError, setFormError] = useState("");
  const form = useAppForm({
    defaultValues: { name: "", slug: "" },
    onSubmitInvalid: () => scheduleFocusInvalidField(formRef.current),
    onSubmit: async ({ value }) => {
      const name = value.name.trim();
      const slug = value.slug.trim();
      if (!name || !slug) return;
      setFormError("");
      try {
        await onCreate({ name, slug });
      } catch (cause) {
        const problem = createProblem(cause);
        if (problem.field === "slug") {
          setFieldServerError(form, "slug", problem.message, formRef.current);
        } else {
          setFormError(problem.message);
        }
      }
    },
  });

  return (
    <form.AppForm>
      <form
        ref={formRef}
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <div className={fieldsClassName}>
          <form.AppField name="name">
            {(field) => (
              <field.Input
                label={m.workspace_name_label()}
                isRequired
                maxLength={WORKSPACE_NAME_MAX_LENGTH}
                placeholder={m.workspace_name_placeholder()}
                onChange={(next) => {
                  if (!slugEdited.current) {
                    form.setFieldValue("slug", nameToWorkspaceSlug(next));
                  }
                }}
              />
            )}
          </form.AppField>
          <form.AppField
            name="slug"
            validators={{
              onChange: ({ value }) => slugProblem(value.trim()),
              onSubmit: ({ value }) => slugProblem(value.trim()),
            }}
          >
            {(field) => (
              <field.Input
                label={m.workspace_slug_label()}
                isRequired
                placeholder={m.workspace_slug_placeholder()}
                hint={m.workspace_slug_hint()}
                onChange={() => {
                  slugEdited.current = true;
                }}
              />
            )}
          </form.AppField>
          <form.Alert error={formError} />
        </div>
        <form.Subscribe
          selector={(state) => ({
            submitting: state.isSubmitting,
            slugInvalid: Boolean(slugProblem(state.values.slug.trim())),
          })}
        >
          {({ submitting, slugInvalid }) =>
            actions({
              type: "submit",
              isDisabled: slugInvalid,
              isLoading: submitting,
              showTextWhileLoading: true,
              children: submitting ? m.workspace_create_submitting() : m.workspace_create_submit(),
            })
          }
        </form.Subscribe>
      </form>
    </form.AppForm>
  );
}
