import { useEffect, useRef, useState } from "react";
import { Button as AriaButton, FileTrigger } from "react-aria-components";
import { Building07 as Building, Camera01, Check } from "@untitledui/icons";
import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { useAppForm, visibleFieldError } from "#src/components/ui/form";
import { WorkspaceIcon } from "#src/features/workspaces/workspace-icon";
import { WORKSPACE_NAME_MAX_LENGTH } from "#src/features/workspaces/workspace.schemas";
import { isValidWorkspaceSlug } from "#src/features/workspaces/workspace-slug";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { fieldHint, scheduleFocusInvalidField } from "#src/lib/form-field-error";
import { IMAGE_MAX_BYTES, IMAGE_UPLOAD_TYPES } from "#src/lib/image-upload";
import type { SettingsContentProps } from "./settings-content";
import { cn } from "#src/lib/utils";
import { isAppError, isAppErrorCode, type AppErrorCode } from "#src/lib/app-error";
import { SettingsCard, SettingsGroup, SettingsPage } from "#src/components/settings-layout";
import { SaveErrorMessage, saveErrorFrom, type SaveError } from "#src/components/save-error";
import { m } from "#src/paraglide/messages";

function messageForCode(
  cause: unknown,
  messages: Partial<Record<AppErrorCode, () => string>>,
  fallback: () => string,
): string {
  return ((isAppError(cause) && messages[cause.code]) || fallback)();
}

const workspaceSlugSaveError = (cause: unknown) =>
  messageForCode(
    cause,
    {
      CONFLICT: m.settings_workspace_url_taken,
      ACCESS_DENIED: m.settings_workspace_url_owner_only,
      INVALID_INPUT: m.settings_workspace_url_invalid,
    },
    m.settings_workspace_url_save_error,
  );

const workspaceIconUploadError = (cause: unknown) =>
  messageForCode(
    cause,
    {
      CONFLICT: m.settings_workspace_icon_conflict,
      ACCESS_DENIED: m.settings_workspace_profile_access_denied,
      INVALID_INPUT: m.settings_workspace_icon_invalid,
    },
    m.settings_workspace_icon_error,
  );

export function WorkspaceProfileSettings({
  workspace,
  canEdit,
  onRename,
  canChangeSlug,
  onSlugChange,
  onIconUpload,
  archivedGroups,
  dangerZone,
}: {
  workspace: SettingsContentProps["workspace"];
  canEdit: boolean;
  onRename: (name: string) => Promise<void>;
  canChangeSlug: boolean;
  onSlugChange: (slug: string) => Promise<void>;
  onIconUpload: (file: File) => Promise<void>;
  archivedGroups: React.ReactNode;
  dangerZone: React.ReactNode;
}) {
  const [uploading, guardUpload] = useSubmitGuard();
  const [iconError, setIconError] = useState<SaveError | null>(null);

  function upload(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setIconError(null);
    if (file.size > IMAGE_MAX_BYTES) {
      setIconError({ message: m.settings_workspace_icon_too_large() });
      return;
    }
    void guardUpload(async () => {
      try {
        await onIconUpload(file);
      } catch (cause) {
        setIconError(saveErrorFrom(workspaceIconUploadError(cause), cause));
      }
    });
  }

  const icon = (
    <WorkspaceIcon
      name={workspace.name}
      url={workspace.iconUrl}
      className="size-16 text-display-xs"
    />
  );
  const uploadLabel = uploading
    ? m.settings_workspace_icon_uploading()
    : m.settings_workspace_icon_upload();

  return (
    <SettingsPage>
      <SettingsGroup icon={Building} label={m.settings_workspace_profile_heading()}>
        <SettingsCard>
          <div className="flex flex-col gap-3">
            <div className="flex min-w-0 items-center gap-4">
              {canEdit ? (
                <FileTrigger acceptedFileTypes={WORKSPACE_ICON_TYPES} onSelect={upload}>
                  <Tooltip title={uploadLabel}>
                    <AriaButton
                      aria-label={uploadLabel}
                      isPending={uploading}
                      className="group relative shrink-0 cursor-pointer rounded-lg outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2 pending:cursor-default pending:opacity-60"
                    >
                      {icon}
                      <span
                        aria-hidden="true"
                        className="absolute inset-0 hidden items-center justify-center rounded-lg bg-overlay/70 text-fg-white group-hover:flex group-focus-visible:flex group-pending:hidden"
                      >
                        <Camera01 className="size-5" />
                      </span>
                      <span
                        aria-hidden="true"
                        className="absolute -right-1 -bottom-1 hidden size-6 place-items-center rounded-full bg-primary text-fg-secondary shadow-xs ring-1 ring-secondary group-pending:hidden [@media(hover:none)]:grid"
                      >
                        <Camera01 className="size-3.5" />
                      </span>
                    </AriaButton>
                  </Tooltip>
                </FileTrigger>
              ) : (
                icon
              )}
              <div className="min-w-0">
                <p className="truncate text-lg font-semibold text-primary">{workspace.name}</p>
                <p className="truncate font-mono text-sm text-tertiary">/{workspace.slug}</p>
              </div>
            </div>
            {iconError && <SaveErrorMessage error={iconError} />}
          </div>
          <div className="flex flex-col gap-6 border-t border-secondary pt-6">
            <WorkspaceNameForm
              workspaceName={workspace.name}
              canEdit={canEdit}
              onRename={onRename}
            />
            <WorkspaceSlugForm
              workspaceSlug={workspace.slug}
              canChangeSlug={canChangeSlug}
              onSlugChange={onSlugChange}
            />
          </div>
        </SettingsCard>
      </SettingsGroup>
      {archivedGroups}
      {dangerZone}
    </SettingsPage>
  );
}

function WorkspaceNameForm({
  workspaceName,
  canEdit,
  onRename,
}: {
  workspaceName: string;
  canEdit: boolean;
  onRename: (name: string) => Promise<void>;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [saving, guardSave] = useSubmitGuard();
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<SaveError | null>(null);

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 2000);
    return () => clearTimeout(timer);
  }, [saved]);

  const form = useAppForm({
    defaultValues: { name: workspaceName },
    onSubmitInvalid: () => scheduleFocusInvalidField(formRef.current),
    onSubmit: async ({ value }) => {
      const trimmed = value.name.trim();
      if (!canEdit || trimmed.length === 0 || trimmed === workspaceName) return;
      await guardSave(async () => {
        setSaveError(null);
        setSaved(false);
        try {
          await onRename(trimmed);
          form.setFieldValue("name", trimmed);
          setSaved(true);
        } catch (cause) {
          setSaveError(
            saveErrorFrom(
              isAppErrorCode(cause, "ACCESS_DENIED")
                ? m.settings_workspace_profile_access_denied()
                : m.settings_workspace_profile_save_error(),
              cause,
            ),
          );
          scheduleFocusInvalidField(formRef.current, "name");
        }
      });
    },
  });

  useEffect(() => {
    form.reset({ name: workspaceName });
  }, [form, workspaceName]);

  return (
    <form.AppForm>
      <form
        ref={formRef}
        noValidate
        className="flex max-w-xl flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <form.AppField name="name">
          {(field) => {
            const fieldError = visibleFieldError(
              field.state.meta,
              field.form.state.submissionAttempts,
            );
            return (
              <div className="flex flex-col gap-1.5">
                <Input
                  label={m.settings_workspace_name()}
                  name={field.name}
                  value={field.state.value}
                  maxLength={WORKSPACE_NAME_MAX_LENGTH}
                  isInvalid={Boolean(fieldError || saveError)}
                  hint={saveError ? undefined : fieldHint(fieldError)}
                  isReadOnly={!canEdit}
                  isDisabled={saving}
                  hideRequiredIndicator
                  onChange={(next) => {
                    if (field.state.meta.errorMap.onSubmit) {
                      field.setMeta((prev) => ({
                        ...prev,
                        errorMap: { ...prev.errorMap, onSubmit: undefined },
                      }));
                    }
                    field.handleChange(next);
                    setSaved(false);
                    setSaveError(null);
                  }}
                  onBlur={field.handleBlur}
                />
                {saveError && <SaveErrorMessage error={saveError} />}
              </div>
            );
          }}
        </form.AppField>
        {canEdit && (
          <div>
            <form.Subscribe
              selector={(state) => {
                const trimmed = state.values.name.trim();
                return trimmed.length > 0 && trimmed !== workspaceName;
              }}
            >
              {(changed) => (
                <Button
                  type="submit"
                  size="sm"
                  iconLeading={saved ? Check : undefined}
                  isLoading={saving}
                  isDisabled={saving || !changed}
                >
                  {saved
                    ? m.settings_workspace_profile_saved()
                    : m.settings_workspace_profile_save()}
                </Button>
              )}
            </form.Subscribe>
          </div>
        )}
      </form>
    </form.AppForm>
  );
}

function WorkspaceSlugForm({
  workspaceSlug,
  canChangeSlug,
  onSlugChange,
}: {
  workspaceSlug: string;
  canChangeSlug: boolean;
  onSlugChange: (slug: string) => Promise<void>;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [savingSlug, guardSlugSave] = useSubmitGuard();
  const [slugError, setSlugError] = useState<SaveError | null>(null);

  const form = useAppForm({
    defaultValues: { slug: workspaceSlug },
    onSubmitInvalid: () => scheduleFocusInvalidField(formRef.current),
    onSubmit: async ({ value }) => {
      const trimmedSlug = value.slug.trim();
      if (!canChangeSlug || !isValidWorkspaceSlug(trimmedSlug) || trimmedSlug === workspaceSlug) {
        return;
      }
      await guardSlugSave(async () => {
        setSlugError(null);
        try {
          await onSlugChange(trimmedSlug);
        } catch (cause) {
          setSlugError(saveErrorFrom(workspaceSlugSaveError(cause), cause));
          scheduleFocusInvalidField(formRef.current, "slug");
        }
      });
    },
  });

  useEffect(() => {
    form.reset({ slug: workspaceSlug });
  }, [form, workspaceSlug]);

  const validateSlug = ({ value }: { value: string }) => {
    if (!canChangeSlug) return undefined;
    const trimmed = value.trim();
    if (trimmed === workspaceSlug) return undefined;
    return isValidWorkspaceSlug(trimmed) ? undefined : m.settings_workspace_url_invalid();
  };

  return (
    <form.AppForm>
      <form
        ref={formRef}
        noValidate
        className="flex max-w-xl flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <form.AppField
          name="slug"
          validators={{
            onChange: validateSlug,
            onSubmit: validateSlug,
          }}
        >
          {(field) => {
            const fieldError = visibleFieldError(
              field.state.meta,
              field.form.state.submissionAttempts,
            );
            const hint = slugError
              ? undefined
              : !canChangeSlug
                ? m.settings_workspace_url_owner_only()
                : fieldHint(fieldError);
            return (
              <div className="flex flex-col gap-1.5">
                <Input
                  label={m.settings_workspace_url_label()}
                  name={field.name}
                  value={field.state.value}
                  icon={SlugPrefix}
                  inputClassName="font-mono"
                  hint={hint}
                  isInvalid={Boolean(fieldError || slugError)}
                  isReadOnly={!canChangeSlug}
                  isDisabled={savingSlug}
                  excludeFromTabOrder={!canChangeSlug}
                  onChange={(next) => {
                    if (field.state.meta.errorMap.onSubmit) {
                      field.setMeta((prev) => ({
                        ...prev,
                        errorMap: { ...prev.errorMap, onSubmit: undefined },
                      }));
                    }
                    field.handleChange(next);
                    setSlugError(null);
                  }}
                  onBlur={field.handleBlur}
                />
                {slugError && <SaveErrorMessage error={slugError} />}
              </div>
            );
          }}
        </form.AppField>
        {canChangeSlug && (
          <div>
            <form.Subscribe
              selector={(state) => {
                const trimmed = state.values.slug.trim();
                return isValidWorkspaceSlug(trimmed) && trimmed !== workspaceSlug;
              }}
            >
              {(canSave) => (
                <Button
                  type="submit"
                  size="sm"
                  isLoading={savingSlug}
                  isDisabled={savingSlug || !canSave}
                >
                  {m.settings_workspace_url_save()}
                </Button>
              )}
            </form.Subscribe>
          </div>
        )}
      </form>
    </form.AppForm>
  );
}

const WORKSPACE_ICON_TYPES = [...IMAGE_UPLOAD_TYPES];

function SlugPrefix({ className }: { className?: string }) {
  return (
    <span className={cn(className, "flex items-center justify-center font-mono text-md")}>/w/</span>
  );
}
