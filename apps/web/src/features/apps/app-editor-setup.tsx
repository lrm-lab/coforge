import { useState } from "react";
import { LinkExternal01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { Checkbox } from "#src/components/base/checkbox/checkbox";
import { Input } from "#src/components/base/input/input";
import { Alert } from "#src/components/ui/alert";
import { m } from "#src/paraglide/messages";
import type { AppSetupField, AppSetupSummary } from "./app-installation-setup";
import type { SetupDraft } from "./app-setup-draft";
import { SetupDirections, SetupStatusBadge } from "./setup-status-badge";

export type SetupErrors = Partial<Record<AppSetupField, string>>;

/**
 * The Installation setup section: whether the app needs configuring after installation, the page
 * and the one line that says what to do there, saved with the form's Save. Below, when the app is
 * installed in this Workspace: its saved status, the link to open the page, and Refresh status.
 */
export function SetupSection({
  draft,
  setup,
  errors,
  isDisabled,
  onChange,
  onRefresh,
}: {
  draft: SetupDraft;
  /** The saved setup, and this Workspace's installation of it when there is one; none while
   * registering. */
  setup: AppSetupSummary | undefined;
  errors: SetupErrors;
  isDisabled: boolean;
  onChange: (draft: SetupDraft) => void;
  /** Reads the status again; throws when it can't. */
  onRefresh: () => Promise<void>;
}) {
  const unsaved =
    draft.required !== (setup?.url != null) || draft.url.trim() !== (setup?.url ?? "");
  return (
    <>
      <div className="grid gap-5">
        <Checkbox
          label={m.apps_setup_required()}
          hint={m.apps_setup_required_hint()}
          isDisabled={isDisabled}
          isSelected={draft.required}
          onChange={(required) => onChange({ ...draft, required })}
        />
        {draft.required && (
          <>
            <Input
              label={m.apps_setup_url_label()}
              type="url"
              inputMode="url"
              placeholder="https://example.com/setup"
              isRequired
              isDisabled={isDisabled}
              isInvalid={Boolean(errors.url)}
              hint={errors.url ?? m.apps_setup_url_hint()}
              value={draft.url}
              onChange={(url) => onChange({ ...draft, url })}
            />
            <Input
              label={m.apps_setup_description_label()}
              placeholder={m.apps_setup_description_placeholder()}
              isDisabled={isDisabled}
              isInvalid={Boolean(errors.description)}
              hint={errors.description ?? m.apps_setup_description_hint()}
              value={draft.description}
              onChange={(description) => onChange({ ...draft, description })}
            />
          </>
        )}
        <p className="text-sm text-tertiary">{m.apps_setup_revision_hint()}</p>
      </div>
      {setup?.installation && (
        <SetupStatusCard
          installation={setup.installation}
          url={setup.url}
          description={setup.description}
          unsaved={unsaved}
          canManage
          onRefresh={onRefresh}
        />
      )}
    </>
  );
}

/** This Workspace's installation's saved setup status (also the read-only app detail's), with the page to continue or manage it on
 * (opened in a new tab) and a refresh, since the app reports completion on its own. */
export function SetupStatusCard({
  installation,
  url,
  description,
  unsaved = false,
  canManage,
  onRefresh,
}: {
  installation: NonNullable<AppSetupSummary["installation"]>;
  /** The saved page and instructions the installer is shown. */
  url: string | null;
  description: string;
  unsaved?: boolean;
  /** An owner or admin: the link to continue or manage setup is theirs; everyone else is told
   * an owner or admin manages it (Refresh status stays for all: it only reads). */
  canManage: boolean;
  onRefresh: () => Promise<void>;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [failed, setFailed] = useState(false);

  async function refresh() {
    setRefreshing(true);
    setFailed(false);
    try {
      await onRefresh();
    } catch {
      setFailed(true);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="grid gap-3 rounded-xl border border-secondary p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold text-primary">{m.apps_setup_card_title()}</p>
        <SetupStatusBadge status={installation.status} />
      </div>
      {url !== null && installation.status !== "complete" && (
        <SetupDirections url={url} description={description} />
      )}
      {unsaved && <p className="text-sm text-tertiary">{m.apps_setup_unsaved()}</p>}
      {failed && <Alert color="warning" title={m.apps_setup_refresh_error()} />}
      {!canManage && (
        <p className="text-sm text-tertiary">
          {installation.status === "complete"
            ? m.apps_setup_admin_manages_note()
            : m.apps_setup_member_note()}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        {canManage && installation.link && (
          <Button
            size="sm"
            color="secondary"
            href={installation.link}
            target="_blank"
            rel="noopener noreferrer"
            iconTrailing={LinkExternal01}
          >
            {installation.status === "complete" ? m.apps_setup_manage() : m.apps_setup_continue()}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          color="tertiary"
          isDisabled={refreshing}
          isLoading={refreshing}
          showTextWhileLoading
          onPress={() => void refresh()}
        >
          {refreshing ? m.apps_setup_refreshing() : m.apps_setup_refresh()}
        </Button>
      </div>
      {canManage && installation.link && (
        <p className="text-sm text-tertiary">
          {m.apps_setup_opens_in_new_tab({ host: new URL(installation.link).host })}
        </p>
      )}
    </div>
  );
}
