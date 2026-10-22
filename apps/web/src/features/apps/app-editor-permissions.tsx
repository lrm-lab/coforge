import { useState } from "react";

import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { Checkbox } from "#src/components/base/checkbox/checkbox";
import { Alert } from "#src/components/ui/alert";
import { m } from "#src/paraglide/messages";
import { isPermissionsChanged } from "./app-form";
import { APP_PERMISSION_GROUP_COPY } from "./app-permission-copy";
import {
  APP_PERMISSION_GROUPS,
  samePermissionGroups,
  type AppPermissionGroup,
  type AppPermissionsSummary,
} from "./app-permissions";

/**
 * App permissions: the four data groups, each a checkbox for read-only access, saved with the
 * form's Save. Below them, once the app is installed here: what it reads now and, when the saved
 * declaration asks for more, every group it asks for (the new ones marked) and Approve update,
 * which acts at once. The installation itself is `InstallationCard`.
 */
export function PermissionFields({
  groups,
  permissions,
  isDisabled,
  onChange,
  onApprove,
  installationShownAbove,
}: {
  /** The groups chosen in the form, saved or not. */
  groups: AppPermissionGroup[];
  /** The app's saved permissions and this Workspace's approval of them; none while registering. */
  permissions: AppPermissionsSummary | undefined;
  isDisabled: boolean;
  onChange: (groups: AppPermissionGroup[]) => void;
  /** Approves the saved declaration at its revision; throws when refused. */
  onApprove: () => Promise<void>;
  /** The installation card is in the section above, so this one points to it. */
  installationShownAbove: boolean;
}) {
  return (
    <>
      <div className="grid gap-3">
        {APP_PERMISSION_GROUPS.map((group) => {
          const copy = APP_PERMISSION_GROUP_COPY[group];
          return (
            <Checkbox
              key={group}
              label={copy.label()}
              hint={copy.description()}
              isDisabled={isDisabled}
              isSelected={groups.includes(group)}
              onChange={(read) =>
                onChange(
                  APP_PERMISSION_GROUPS.filter((candidate) =>
                    candidate === group ? read : groups.includes(candidate),
                  ),
                )
              }
            />
          );
        })}
        <p className="text-sm text-tertiary">{m.apps_permissions_hint()}</p>
        {!permissions && (
          <p className="text-sm text-tertiary">{m.apps_permissions_register_hint()}</p>
        )}
        {installationShownAbove && (
          <p className="text-sm text-tertiary">{m.apps_installation_shown_above()}</p>
        )}
      </div>
      {permissions && (
        <InstallationApproval
          permissions={permissions}
          unsaved={!samePermissionGroups(groups, permissions.declared)}
          isDisabled={isDisabled}
          onApprove={onApprove}
        />
      )}
    </>
  );
}

/** What this Workspace's installation reads now, and the update waiting for approval. A refusal
 * because the app declared again since is explained once the editor shows the latest. */
function InstallationApproval({
  permissions,
  unsaved,
  isDisabled,
  onApprove,
}: {
  permissions: AppPermissionsSummary;
  unsaved: boolean;
  isDisabled: boolean;
  onApprove: () => Promise<void>;
}) {
  const [approving, setApproving] = useState(false);
  // What a refusal left: the revision it was made at when the app had declared again since (the
  // editor reloads it, and the reason shows once it holds a newer one), or a plain failure.
  const [refusedAt, setRefusedAt] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const pending = permissions.pending;
  const reloaded = refusedAt !== null && permissions.revision !== refusedAt;
  const problem = reloaded
    ? m.apps_permissions_changed()
    : failed || refusedAt !== null
      ? m.apps_installation_approve_error()
      : "";

  async function approve() {
    setApproving(true);
    setRefusedAt(null);
    setFailed(false);
    try {
      await onApprove();
    } catch (cause) {
      if (isPermissionsChanged(cause)) setRefusedAt(permissions.revision);
      else setFailed(true);
    } finally {
      setApproving(false);
    }
  }

  return (
    <div className="grid gap-3 rounded-xl border border-secondary p-4">
      <div className="grid gap-1.5">
        <p className="text-sm text-tertiary">{m.apps_installation_reads()}</p>
        <div className="flex flex-wrap gap-1.5">
          {permissions.effective.length === 0 ? (
            <span className="text-sm text-secondary">{m.apps_installation_reads_nothing()}</span>
          ) : (
            permissions.effective.map((group) => (
              <Badge key={group} size="sm" color="gray">
                {APP_PERMISSION_GROUP_COPY[group].label()}
              </Badge>
            ))
          )}
        </div>
      </div>
      {problem && <Alert color="warning" title={problem} />}
      {pending.length > 0 && (
        <Alert
          color="warning"
          title={m.apps_installation_pending_title()}
          description={
            <>
              {m.apps_installation_pending_description()}
              <span className="mt-2 block">{m.apps_installation_pending_all()}</span>
              <ul className="mt-1.5 flex flex-wrap gap-1.5">
                {permissions.declared.map((group) => (
                  <li key={group}>
                    <Badge size="sm" color={pending.includes(group) ? "warning" : "gray"}>
                      {APP_PERMISSION_GROUP_COPY[group].label()}
                      {pending.includes(group) && ` · ${m.apps_installation_new_badge()}`}
                    </Badge>
                  </li>
                ))}
              </ul>
              {unsaved && <span className="mt-1 block">{m.apps_installation_unsaved()}</span>}
            </>
          }
          actions={
            <Button
              type="button"
              size="sm"
              color="primary"
              isDisabled={isDisabled || approving}
              isLoading={approving}
              showTextWhileLoading
              onPress={() => void approve()}
            >
              {approving ? m.apps_installation_approving() : m.apps_installation_approve()}
            </Button>
          }
        />
      )}
    </div>
  );
}
