import { useRef, useState } from "react";
import { useStore } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft } from "@untitledui/icons";
import { PageHeader } from "#src/components/layout/page-header";
import { Button } from "#src/components/base/buttons/button";
import { Select } from "#src/components/base/select/select";
import { Toggle } from "#src/components/base/toggle/toggle";
import { setFieldServerError, useAppForm } from "#src/components/ui/form";
import { listAccessibleGitHubRepositories } from "#src/features/integrations/github.functions";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { isAppErrorCode } from "#src/lib/app-error";
import { scheduleFocusInvalidField } from "#src/lib/form-field-error";
import { m } from "#src/paraglide/messages";
import {
  deleteProject,
  updateProject,
  uploadProjectIcon,
  type getProject,
} from "./projects.functions";
import { ProjectImage } from "./project-image";

export function ProjectSettingsPage({
  project,
}: {
  project: NonNullable<Awaited<ReturnType<typeof getProject>>>;
}) {
  const router = useRouter();
  const workspaceSlug = useWorkspaceSlug();
  const save = useServerFn(updateProject);
  const remove = useServerFn(deleteProject);
  const upload = useServerFn(uploadProjectIcon);
  const repositories = useServerFn(listAccessibleGitHubRepositories);
  const [imageMessage, setImageMessage] = useState("");
  const [imageBusy, setImageBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const settingsFormRef = useRef<HTMLFormElement>(null);
  const deleteFormRef = useRef<HTMLFormElement>(null);

  const repositoriesQuery = useQuery({
    queryKey: ["github", "repositories"],
    queryFn: () => repositories(),
    retry: false,
  });
  const items = repositoriesQuery.data ?? [];
  const loading = repositoriesQuery.isPending;
  const repositoryError = repositoriesQuery.isError;

  const settingsForm = useAppForm({
    defaultValues: {
      name: project.name,
      description: project.description,
      selection: "keep",
      commitCoAuthor: project.commitCoAuthor,
    },
    onSubmitInvalid: () => scheduleFocusInvalidField(settingsFormRef.current),
    onSubmit: async ({ value }) => {
      if (imageBusy) return;
      setSaved(false);
      setError("");
      try {
        const repository = items.find((item) => String(item.id) === value.selection);
        await save({
          data: {
            id: project.id,
            name: value.name,
            description: value.description,
            commitCoAuthor: value.commitCoAuthor,
            ...(value.selection === "none"
              ? { repository: null }
              : repository
                ? {
                    repository: {
                      id: repository.id,
                      installationId: repository.installationId,
                      fullName: repository.fullName,
                    },
                  }
                : {}),
          },
        });
        await router.invalidate({ sync: true });
        settingsForm.reset({
          name: value.name.trim(),
          description: value.description.trim(),
          selection: "keep",
          commitCoAuthor: value.commitCoAuthor,
        });
        setSaved(true);
      } catch (cause) {
        if (isAppErrorCode(cause, "ACCESS_DENIED")) {
          setFieldServerError(
            settingsForm,
            "selection",
            m.project_repository_needs_access(),
            settingsFormRef.current,
          );
        } else {
          setError(m.project_settings_error());
        }
      }
    },
  });

  const deleteForm = useAppForm({
    defaultValues: { confirmation: "" },
    onSubmitInvalid: () => scheduleFocusInvalidField(deleteFormRef.current),
    onSubmit: async ({ value }) => {
      if (imageBusy) return;
      setSaved(false);
      setError("");
      try {
        await remove({ data: { id: project.id, confirmation: value.confirmation } });
        await router.navigate({ to: "/w/$workspaceSlug/projects", params: { workspaceSlug } });
        await router.invalidate({ sync: true });
      } catch (cause) {
        if (isAppErrorCode(cause, "INVALID_INPUT")) {
          setFieldServerError(
            deleteForm,
            "confirmation",
            m.project_delete_confirm({ name: project.name }),
            deleteFormRef.current,
          );
        } else {
          setError(m.project_delete_error());
        }
      }
    },
  });

  const { name, settingsBusy } = useStore(settingsForm.store, (state) => ({
    name: state.values.name,
    settingsBusy: state.isSubmitting,
  }));
  const { confirmation, deleteBusy } = useStore(deleteForm.store, (state) => ({
    confirmation: state.values.confirmation,
    deleteBusy: state.isSubmitting,
  }));
  const busy = imageBusy || settingsBusy || deleteBusy;

  async function changeImage(file: File) {
    if (busy) return;
    setImageBusy(true);
    setError("");
    setSaved(false);
    setImageMessage(m.project_image_uploading());
    try {
      const data = new FormData();
      data.set("id", project.id);
      data.set("file", file);
      await upload({ data });
      await router.invalidate({ sync: true });
      setImageMessage(m.project_image_saved());
    } catch {
      setImageMessage("");
      setError(m.project_image_error());
    } finally {
      setImageBusy(false);
    }
  }

  return (
    <main className="flex h-full min-w-0 flex-col bg-primary">
      <PageHeader
        heading={m.project_settings()}
        breadcrumbs={[
          {
            label: m.projects_title(),
            link: (className) => (
              <Link
                to="/w/$workspaceSlug/projects"
                params={{ workspaceSlug }}
                activeOptions={{ exact: true }}
                className={className}
              >
                {m.projects_title()}
              </Link>
            ),
          },
          {
            label: project.name,
            link: (className) => (
              <Link
                to="/w/$workspaceSlug/projects/$projectSlug"
                params={{ workspaceSlug, projectSlug: project.slug }}
                activeOptions={{ exact: true }}
                className={className}
              >
                {project.name}
              </Link>
            ),
          },
        ]}
        leading={
          <Link
            to="/w/$workspaceSlug/projects/$projectSlug"
            params={{ workspaceSlug, projectSlug: project.slug }}
            aria-label={project.name}
            className="shrink-0 rounded-lg p-2 text-tertiary outline-focus-ring hover:bg-primary_hover focus-visible:outline-2"
          >
            <ArrowLeft aria-hidden="true" className="size-5" />
          </Link>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-page py-6 sm:py-8">
        {deleting ? (
          <deleteForm.AppForm>
            <form
              ref={deleteFormRef}
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void deleteForm.handleSubmit();
              }}
              className="mx-auto grid w-full max-w-xl grid-cols-[minmax(0,1fr)] gap-6"
            >
              <h2 className="text-lg font-semibold">{m.project_delete()}</h2>
              <p className="text-sm text-tertiary">{m.project_delete_warning()}</p>
              <deleteForm.AppField
                name="confirmation"
                validators={{
                  onSubmit: ({ value }) =>
                    value === project.name
                      ? undefined
                      : m.project_delete_confirm({ name: project.name }),
                }}
              >
                {(field) => (
                  <field.Input
                    label={m.project_delete_confirm({ name: project.name })}
                    autoFocus
                    isRequired
                    isDisabled={busy}
                    onChange={() => setError("")}
                  />
                )}
              </deleteForm.AppField>
              <deleteForm.Alert error={error} />
              <div className="flex items-center justify-end gap-3">
                <Button
                  size="sm"
                  color="secondary"
                  isDisabled={busy}
                  onPress={() => {
                    setDeleting(false);
                    deleteForm.reset({ confirmation: "" });
                    setError("");
                  }}
                >
                  {m.controls_cancel()}
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  color="primary-destructive"
                  isLoading={busy}
                  isDisabled={confirmation !== project.name}
                  showTextWhileLoading
                >
                  {m.project_delete()}
                </Button>
              </div>
            </form>
          </deleteForm.AppForm>
        ) : (
          <settingsForm.AppForm>
            <form
              ref={settingsFormRef}
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void settingsForm.handleSubmit();
              }}
              onChange={() => setSaved(false)}
              className="mx-auto grid w-full max-w-xl grid-cols-[minmax(0,1fr)] gap-6"
            >
              <div className="flex items-center gap-4">
                <label className="cursor-pointer rounded-xl outline-focus-ring focus-within:outline-2 focus-within:outline-offset-4">
                  <ProjectImage
                    name={project.name}
                    url={project.iconUrl}
                    className="size-16 text-display-xs"
                  />
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    aria-label={m.project_image_upload()}
                    disabled={busy}
                    className="sr-only"
                    onChange={async (event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = "";
                      if (file) await changeImage(file);
                    }}
                  />
                </label>
                <div className="min-w-0 space-y-1">
                  <p className="text-sm font-medium">{m.project_image_upload()}</p>
                  <p className="text-sm text-tertiary">{m.project_image_hint()}</p>
                  {imageMessage && (
                    <p role="status" className="text-sm text-tertiary">
                      {imageMessage}
                    </p>
                  )}
                </div>
              </div>
              <settingsForm.AppField
                name="name"
                validators={{
                  onSubmit: ({ value }) => (value.trim() ? undefined : m.project_settings_error()),
                }}
              >
                {(field) => (
                  <field.Input
                    label={m.project_name()}
                    isRequired
                    maxLength={100}
                    isDisabled={busy}
                    onChange={() => {
                      setSaved(false);
                      setError("");
                    }}
                  />
                )}
              </settingsForm.AppField>
              <settingsForm.AppField name="description">
                {(field) => (
                  <field.TextArea
                    label={m.project_description()}
                    rows={3}
                    maxLength={2000}
                    isDisabled={busy}
                    textAreaClassName="resize-y"
                    onChange={() => {
                      setSaved(false);
                      setError("");
                    }}
                  />
                )}
              </settingsForm.AppField>
              <settingsForm.AppField name="selection">
                {(field) => (
                  <field.Select
                    label={m.project_repository()}
                    isDisabled={busy}
                    onSelectionChange={() => {
                      setSaved(false);
                      setError("");
                    }}
                  >
                    <Select.Item
                      id="keep"
                      label={project.githubFullName ?? m.project_no_repository()}
                    />
                    {project.githubFullName && (
                      <Select.Item id="none" label={m.project_repository_disconnect()} />
                    )}
                    {items.map((item) => (
                      <Select.Item key={item.id} id={String(item.id)} label={item.fullName} />
                    ))}
                  </field.Select>
                )}
              </settingsForm.AppField>
              {loading && (
                <p role="status" className="text-sm text-tertiary">
                  {m.project_repository_loading()}
                </p>
              )}
              {repositoryError && (
                <p role="status" className="text-sm text-tertiary">
                  {m.project_repository_unavailable()}
                </p>
              )}
              {!loading && (repositoryError || items.length === 0) && (
                <Link
                  to="/w/$workspaceSlug/settings"
                  params={{ workspaceSlug }}
                  search={{ section: "integrations" }}
                  className="text-sm font-medium text-brand-secondary hover:underline"
                >
                  {m.project_github_settings()}
                </Link>
              )}
              <settingsForm.AppField name="commitCoAuthor">
                {(field) => (
                  <Toggle
                    size="md"
                    className="max-w-full"
                    label={m.project_commit_coauthor()}
                    hint={m.project_commit_coauthor_hint()}
                    isDisabled={busy}
                    isSelected={field.state.value}
                    onChange={(isSelected) => {
                      field.handleChange(isSelected);
                      setSaved(false);
                      setError("");
                    }}
                  />
                )}
              </settingsForm.AppField>
              <settingsForm.Alert error={error} />
              <div className="flex items-center justify-end gap-3">
                {saved && (
                  <p role="status" className="mr-auto text-sm text-tertiary">
                    {m.project_saved()}
                  </p>
                )}
                <Button
                  type="submit"
                  size="sm"
                  color="primary"
                  isLoading={busy}
                  isDisabled={!name.trim()}
                  showTextWhileLoading
                >
                  {m.project_save()}
                </Button>
              </div>
              <div className="border-t border-secondary pt-4">
                <Button
                  size="sm"
                  color="secondary-destructive"
                  isDisabled={busy}
                  onPress={() => {
                    setDeleting(true);
                    setSaved(false);
                    setError("");
                  }}
                >
                  {m.project_delete()}
                </Button>
              </div>
            </form>
          </settingsForm.AppForm>
        )}
      </div>
    </main>
  );
}
