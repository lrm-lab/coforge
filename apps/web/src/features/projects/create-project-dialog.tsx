import { useEffect, useRef, useState, type ComponentType, type SVGProps } from "react";
import { useStore } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { ChevronRight, FolderLock, GitBranch01, Share04 } from "@untitledui/icons";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { PHONE_PAGE_HEADER, PhoneFormBar } from "#src/components/ui/phone-form-bar";
import {
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from "#src/components/ui/unsaved-changes-dialog";
import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { Button } from "#src/components/base/buttons/button";
import { SelectItem } from "#src/components/base/select/select-item";
import { setFieldServerError, useAppForm } from "#src/components/ui/form";
import {
  getGitHubConnection,
  listAccessibleGitHubRepositories,
} from "#src/features/integrations/github.functions";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { isAppErrorCode } from "#src/lib/app-error";
import { scheduleFocusInvalidField } from "#src/lib/form-field-error";
import { nameToSlug } from "#src/lib/slug";
import { m } from "#src/paraglide/messages";
import { parseGitHubRepositoryInput } from "./github-repository-input";
import { createProject } from "./projects.functions";
import { isValidProjectSlug, PROJECT_SLUG_MAX_LENGTH } from "./projects.schemas";
import {
  DialogAction,
  DialogActions,
  DialogCancel,
  useDialogControlSize,
} from "#src/components/ui/dialog-actions";

type Source = "scratch" | "github";

export function CreateProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (project: { slug: string }) => Promise<void>;
}) {
  const controlSize = useDialogControlSize();
  const workspaceSlug = useWorkspaceSlug();
  const repositories = useServerFn(listAccessibleGitHubRepositories);
  const githubConnection = useServerFn(getGitHubConnection);
  const create = useServerFn(createProject);
  const [step, setStep] = useState<"choose" | "form">("choose");
  const [source, setSource] = useState<Source>("scratch");
  const [repositoryId, setRepositoryId] = useState(0);
  const [submitError, setError] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const slugTouched = useRef(false);
  const nameTouched = useRef(false);

  const githubFormActive = open && step === "form" && source === "github";
  const connectionQuery = useQuery({
    queryKey: ["github", "connection"],
    queryFn: () => githubConnection(),
    enabled: githubFormActive,
    retry: false,
  });
  const connection = connectionQuery.data ?? null;
  const githubConnected = connection?.status === "connected";
  const repositoriesQuery = useQuery({
    queryKey: ["github", "repositories"],
    queryFn: () => repositories(),
    enabled: githubFormActive && githubConnected,
    retry: false,
  });
  const items = repositoriesQuery.data ?? [];
  const needsRepository = source === "github";

  const form = useAppForm({
    defaultValues: { name: "", slug: "", repository: "" },
    onSubmitInvalid: () => scheduleFocusInvalidField(formRef.current),
    onSubmit: async ({ value }) => {
      const repo = items.find((item) => item.id === repositoryId);
      const parsed = parseGitHubRepositoryInput(value.repository);
      const publicName = parsed?.fullName;
      if (needsRepository && !repo && !publicName) {
        setFieldServerError(
          form,
          "repository",
          connection && !githubConnected
            ? m.project_repository_not_connected()
            : m.project_create_error(),
          formRef.current,
        );
        return;
      }
      setError("");
      try {
        await create({
          data: repo
            ? {
                name: value.name,
                slug: value.slug,
                installationId: repo.installationId,
                repositoryId: repo.id,
                fullName: repo.fullName,
              }
            : publicName
              ? { name: value.name, slug: value.slug, fullName: publicName }
              : { name: value.name, slug: value.slug },
        });
        await onCreated({ slug: value.slug });
        onOpenChange(false);
      } catch (cause) {
        if (isAppErrorCode(cause, "CONFLICT")) {
          setFieldServerError(form, "slug", m.project_slug_taken(), formRef.current);
        } else if (isAppErrorCode(cause, "ACCESS_DENIED") && needsRepository) {
          setFieldServerError(
            form,
            "repository",
            m.project_repository_needs_access(),
            formRef.current,
          );
        } else {
          setError(
            isAppErrorCode(cause, "ACCESS_DENIED")
              ? m.project_repository_needs_access()
              : m.project_create_error(),
          );
        }
      }
    },
  });

  const { name, slug, repositoryQuery, busy } = useStore(form.store, (state) => ({
    name: state.values.name,
    slug: state.values.slug,
    repositoryQuery: state.values.repository,
    busy: state.isSubmitting,
  }));

  const error =
    submitError ||
    (githubFormActive && (connectionQuery.isError || repositoriesQuery.isError)
      ? m.project_repository_unavailable()
      : "");

  const slugError = slug.length > 0 && !isValidProjectSlug(slug) ? m.project_slug_invalid() : "";
  const selectedRepository = items.find((item) => item.id === repositoryId);
  const parsedRepository = parseGitHubRepositoryInput(repositoryQuery);
  const canSubmit =
    name.trim().length > 0 &&
    slug.trim().length > 0 &&
    !slugError &&
    (!needsRepository || Boolean(selectedRepository || parsedRepository));

  useEffect(() => {
    if (!open) return;
    setStep("choose");
    setSource("scratch");
    setError("");
    form.reset({ name: "", slug: "", repository: "" });
    setRepositoryId(0);
    nameTouched.current = false;
    slugTouched.current = false;
  }, [form, open]);

  function clearFieldSubmitError(field: "slug" | "repository") {
    form.setFieldMeta(field, (prev) =>
      prev.errorMap.onSubmit
        ? { ...prev, errorMap: { ...prev.errorMap, onSubmit: undefined } }
        : prev,
    );
  }

  function resetForm() {
    setError("");
    form.reset({ name: "", slug: "", repository: "" });
    setRepositoryId(0);
    nameTouched.current = false;
    slugTouched.current = false;
  }

  function chooseSource(next: Source) {
    setSource(next);
    resetForm();
    setStep("form");
  }

  function changeName(value: string) {
    setError("");
    nameTouched.current = true;
    if (!slugTouched.current) {
      form.setFieldValue("slug", nameToSlug(value, PROJECT_SLUG_MAX_LENGTH));
      clearFieldSubmitError("slug");
    }
  }

  function changeSlug(value: string) {
    setError("");
    if (value.length === 0) {
      slugTouched.current = false;
      form.setFieldValue("slug", nameToSlug(form.getFieldValue("name"), PROJECT_SLUG_MAX_LENGTH));
      return;
    }
    slugTouched.current = true;
  }

  function applyRepositoryName(fullName: string) {
    if (nameTouched.current) return;
    const shortName = fullName.split("/").pop() || fullName;
    form.setFieldValue("name", shortName);
    if (!slugTouched.current) {
      form.setFieldValue("slug", nameToSlug(shortName, PROJECT_SLUG_MAX_LENGTH));
      clearFieldSubmitError("slug");
    }
  }

  function applyRepositoryQuery(value: string) {
    setError("");
    const parsed = parseGitHubRepositoryInput(value);
    const match = parsed
      ? items.find((item) => item.fullName.toLowerCase() === parsed.fullName.toLowerCase())
      : undefined;
    setRepositoryId(match?.id ?? 0);
    if (parsed) applyRepositoryName(parsed.fullName);
  }

  function selectRepository(id: number) {
    setError("");
    clearFieldSubmitError("repository");
    const repo = items.find((item) => item.id === id);
    if (!repo) {
      setRepositoryId(0);
      return;
    }
    setRepositoryId(repo.id);
    form.setFieldValue("repository", repo.fullName);
    applyRepositoryName(repo.fullName);
  }

  const repositoryHint =
    needsRepository && connection && !githubConnected
      ? m.project_repository_not_connected()
      : undefined;

  const dirty =
    step === "form" && (name.trim() !== "" || slug.trim() !== "" || repositoryQuery.trim() !== "");
  const guard = useUnsavedChangesGuard({
    overlayOpen: open,
    dirty,
    close: () => onOpenChange(false),
  });

  return (
    <>
      <ModalOverlay
        page
        isOpen={open}
        onOpenChange={(next) => {
          if (busy) return;
          if (next) onOpenChange(true);
          else guard.requestClose();
        }}
      >
        <Modal className="w-[min(30rem,calc(100vw-2rem))]">
          <Dialog>
            {() => (
              <>
                <PhoneFormBar
                  heading={m.project_create_title()}
                  pending={busy}
                  {...(step === "choose"
                    ? { onCancel: guard.requestClose }
                    : {
                        cancelLabel: m.controls_back(),
                        onCancel: () => setStep("choose"),
                        submitLabel: m.controls_create(),
                        submitDisabled: !canSubmit,
                        onSubmit: () => formRef.current?.requestSubmit(),
                      })}
                />
                <DialogHeader
                  className={PHONE_PAGE_HEADER}
                  title={m.project_create_title()}
                  description={
                    step === "choose" ? m.project_create_source_description() : undefined
                  }
                  onClose={busy ? undefined : guard.requestClose}
                />
                {step === "choose" ? (
                  <>
                    <div className="grid gap-3 px-6 py-6 max-sm:px-4 max-sm:py-4">
                      <SourceOption
                        icon={FolderLock}
                        label={m.project_create_from_scratch()}
                        description={m.project_create_from_scratch_description()}
                        onSelect={() => chooseSource("scratch")}
                      />
                      <SourceOption
                        icon={GitBranch01}
                        label={m.project_create_from_github()}
                        description={m.project_create_from_github_description()}
                        onSelect={() => chooseSource("github")}
                      />
                    </div>
                    <DialogActions className="px-6 pt-4 pb-6 max-sm:hidden">
                      <DialogCancel type="button" onPress={() => onOpenChange(false)}>
                        {m.controls_cancel()}
                      </DialogCancel>
                    </DialogActions>
                  </>
                ) : (
                  <form.AppForm>
                    <form
                      ref={formRef}
                      noValidate
                      onSubmit={(event) => {
                        event.preventDefault();
                        void form.handleSubmit();
                      }}
                    >
                      <div className="grid gap-4 px-6 py-6 max-sm:px-4 max-sm:pt-2">
                        <form.AppField
                          name="name"
                          validators={{
                            onSubmit: ({ value }) =>
                              value.trim().length > 0 ? undefined : m.project_create_error(),
                          }}
                        >
                          {(field) => (
                            <field.Input
                              size={controlSize}
                              label={m.project_name()}
                              isRequired
                              maxLength={100}
                              onChange={changeName}
                            />
                          )}
                        </form.AppField>
                        <form.AppField
                          name="slug"
                          validators={{
                            onChange: ({ value }) =>
                              value.length > 0 && !isValidProjectSlug(value)
                                ? m.project_slug_invalid()
                                : undefined,
                            onSubmit: ({ value }) =>
                              value.trim().length > 0 && isValidProjectSlug(value)
                                ? undefined
                                : m.project_slug_invalid(),
                          }}
                        >
                          {(field) => (
                            <field.Input
                              size={controlSize}
                              label={m.project_slug()}
                              isRequired
                              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                              maxLength={PROJECT_SLUG_MAX_LENGTH}
                              onChange={changeSlug}
                            />
                          )}
                        </form.AppField>
                        {needsRepository && (
                          <>
                            <form.AppField
                              name="repository"
                              validators={{
                                onSubmit: ({ value }) => {
                                  const repo = items.find((item) => item.id === repositoryId);
                                  const parsed = parseGitHubRepositoryInput(value);
                                  if (repo || parsed) return undefined;
                                  return connection && !githubConnected
                                    ? m.project_repository_not_connected()
                                    : m.project_create_error();
                                },
                              }}
                            >
                              {(field) => (
                                <field.ComboBox
                                  size={controlSize}
                                  label={m.project_repository()}
                                  placeholder={m.project_repository_url_placeholder()}
                                  shortcut={false}
                                  allowsCustomValue
                                  items={items.map((item) => ({
                                    id: String(item.id),
                                    label: item.fullName,
                                  }))}
                                  selectedKey={repositoryId ? String(repositoryId) : null}
                                  onInputChange={applyRepositoryQuery}
                                  onSelectionChange={(key) => {
                                    if (key) selectRepository(Number(key));
                                  }}
                                >
                                  {(item) => <SelectItem id={item.id} label={item.label} />}
                                </field.ComboBox>
                              )}
                            </form.AppField>
                            <p className="text-sm text-tertiary">
                              {repositoryHint ? `${repositoryHint} ` : null}
                              {githubConnected ? (
                                <>
                                  {m.github_repository_missing()}{" "}
                                  {connection.installUrl ? (
                                    <a
                                      href={connection.installUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="inline-flex items-center gap-1 font-medium text-secondary underline underline-offset-4 hover:text-primary"
                                    >
                                      {m.github_manage_repository_access()}
                                      <Share04 aria-hidden="true" className="size-4" />
                                    </a>
                                  ) : (
                                    <span className="inline-flex items-center gap-1 font-medium text-secondary">
                                      {m.github_manage_repository_access()}
                                      <Share04 aria-hidden="true" className="size-4" />
                                    </span>
                                  )}
                                </>
                              ) : (
                                <Link
                                  to="/w/$workspaceSlug/settings"
                                  params={{ workspaceSlug }}
                                  search={{ section: "integrations" }}
                                  className="font-medium text-brand-secondary underline underline-offset-4 hover:text-primary"
                                >
                                  {m.github_connect()}
                                </Link>
                              )}
                            </p>
                          </>
                        )}
                        <form.Alert error={error} />
                      </div>
                      <DialogActions className="px-6 pt-4 pb-6 max-sm:hidden">
                        <DialogCancel
                          type="button"
                          onPress={() => setStep("choose")}
                          isDisabled={busy}
                        >
                          {m.controls_back()}
                        </DialogCancel>
                        <DialogAction
                          type="submit"
                          isDisabled={!canSubmit}
                          isLoading={busy}
                          showTextWhileLoading
                        >
                          {m.project_create()}
                        </DialogAction>
                      </DialogActions>
                    </form>
                  </form.AppForm>
                )}
              </>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
      <UnsavedChangesDialog {...guard.promptProps} />
    </>
  );
}

function SourceOption({
  icon: Icon,
  label,
  description,
  onSelect,
}: {
  icon: ComponentType<SVGProps<SVGSVGElement> & { color?: string; size?: number }>;
  label: string;
  description: string;
  onSelect: () => void;
}) {
  return (
    <Button
      type="button"
      color="secondary"
      noTextPadding
      iconTrailing={ChevronRight}
      className="h-auto w-full justify-between gap-3 rounded-xl px-4 py-3 text-left *:data-text:min-w-0 *:data-text:flex-1"
      onPress={onSelect}
    >
      <span className="flex items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-secondary bg-primary text-tertiary shadow-xs">
          <Icon aria-hidden="true" className="size-5" />
        </span>
        <span className="min-w-0 whitespace-normal">
          <span className="block text-sm font-semibold text-primary">{label}</span>
          <span className="mt-0.5 block text-sm font-normal text-tertiary">{description}</span>
        </span>
      </span>
    </Button>
  );
}
