import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { useEffect, useState } from "react";
import { Button as AriaButton, FileTrigger } from "react-aria-components";
import { Building07 as Building, Camera01, Check } from "@untitledui/icons";
import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { WorkspaceIcon } from "#src/features/workspaces/workspace-icon";
import { WORKSPACE_NAME_MAX_LENGTH } from "#src/features/workspaces/workspace.schemas";
import { isValidWorkspaceSlug } from "#src/features/workspaces/workspace-slug";
import { IMAGE_MAX_BYTES, IMAGE_UPLOAD_TYPES } from "#src/lib/image-upload";
import type { SettingsContentProps } from "./settings-content";
import { cn } from "#src/lib/utils";
import { isAppError, isAppErrorCode, type AppErrorCode } from "#src/lib/app-error";
import { SettingsCard, SettingsGroup, SettingsPage } from "#src/components/settings-layout";
import { SaveErrorMessage, saveErrorFrom, type SaveError } from "#src/components/save-error";
import { m } from "#src/paraglide/messages";

/** The sentence for a failed change, by the code the server answered with. */
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

/** Settings → Workspace profile: the Workspace's icon, name and URL. Its owner or an admin changes
 * the name and icon, and only its owner changes the URL; everyone else sees the same card
 * read-only. */
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
  /** The archived channels and Agents groups under the profile, when the viewer has them. */
  archivedGroups: React.ReactNode;
  /** The Danger zone last on the page, when the viewer has one. */
  dangerZone: React.ReactNode;
}) {
  const [name, setName] = useState(workspace.name);
  const [saving, guardSave] = useSubmitGuard();
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<SaveError | null>(null);
  const [uploading, guardUpload] = useSubmitGuard();
  const [iconError, setIconError] = useState<SaveError | null>(null);
  const [slug, setSlug] = useState(workspace.slug);
  const [savingSlug, guardSlugSave] = useSubmitGuard();
  const [slugError, setSlugError] = useState<SaveError | null>(null);
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 2000);
    return () => clearTimeout(timer);
  }, [saved]);

  const trimmed = name.trim();
  const changed = trimmed.length > 0 && trimmed !== workspace.name;
  const trimmedSlug = slug.trim();
  const slugValid = isValidWorkspaceSlug(trimmedSlug);
  const slugChanged = trimmedSlug !== workspace.slug;
  const slugInvalid = canChangeSlug && slugChanged && !slugValid;
  const slugHint = !canChangeSlug ? (
    m.settings_workspace_url_owner_only()
  ) : slugInvalid ? (
    <span role="alert">{m.settings_workspace_url_invalid()}</span>
  ) : undefined;

  function save() {
    void guardSave(async () => {
      setSaveError(null);
      setSaved(false);
      try {
        await onRename(trimmed);
        setName(trimmed);
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
      }
    });
  }

  // On success the page moves to the new URL, which remounts this card, so nothing is reset here.
  function saveSlug() {
    void guardSlugSave(async () => {
      setSlugError(null);
      try {
        await onSlugChange(trimmedSlug);
      } catch (cause) {
        setSlugError(saveErrorFrom(workspaceSlugSaveError(cause), cause));
      }
    });
  }

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
                        className="absolute inset-0 hidden items-center justify-center rounded-lg bg-overlay/70 text-white group-hover:flex group-focus-visible:flex group-pending:hidden"
                      >
                        <Camera01 className="size-5" />
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
            <div className="grid max-w-xl gap-6">
              <Input
                label={m.settings_workspace_name()}
                value={name}
                maxLength={WORKSPACE_NAME_MAX_LENGTH}
                isReadOnly={!canEdit}
                isDisabled={saving}
                hideRequiredIndicator
                onChange={(next) => {
                  setName(next);
                  setSaved(false);
                }}
              />
            </div>
            {canEdit && (
              <div className="flex flex-col items-start gap-2">
                {saveError && <SaveErrorMessage error={saveError} />}
                <Button
                  type="button"
                  iconLeading={saved ? Check : undefined}
                  isDisabled={saving || !changed}
                  onPress={save}
                >
                  {saving
                    ? m.settings_profile_saving()
                    : saved
                      ? m.settings_workspace_profile_saved()
                      : m.settings_workspace_profile_save()}
                </Button>
              </div>
            )}
            <div className="grid max-w-xl gap-6">
              <Input
                label={m.settings_workspace_url_label()}
                value={slug}
                icon={SlugPrefix}
                inputClassName="font-mono"
                hint={slugHint}
                isInvalid={slugInvalid}
                isReadOnly={!canChangeSlug}
                isDisabled={savingSlug}
                excludeFromTabOrder={!canChangeSlug}
                onChange={setSlug}
              />
            </div>
            {canChangeSlug && (
              <div className="flex flex-col items-start gap-2">
                {slugError && <SaveErrorMessage error={slugError} />}
                <Button
                  type="button"
                  isDisabled={savingSlug || !slugValid || !slugChanged}
                  onPress={saveSlug}
                >
                  {savingSlug ? m.settings_profile_saving() : m.settings_workspace_url_save()}
                </Button>
              </div>
            )}
          </div>
        </SettingsCard>
      </SettingsGroup>
      {archivedGroups}
      {dangerZone}
    </SettingsPage>
  );
}

/** FileTrigger takes a mutable list; built once rather than on every render. */
const WORKSPACE_ICON_TYPES = [...IMAGE_UPLOAD_TYPES];

/** The `/w/` a Workspace slug follows in every URL, in the URL field's leading icon slot. */
function SlugPrefix({ className }: { className?: string }) {
  return (
    <span className={cn(className, "flex items-center justify-center font-mono text-md")}>/w/</span>
  );
}
