import { Badge } from "#src/components/base/badges/badges";
import { m } from "#src/paraglide/messages";
import { CopyValueButton } from "./copy-value-button";

/**
 * This Workspace's installation of the app: its ID with a copy button, what the ID is for, and
 * that it is installed. Shown once in the editor, in the first of the Installation setup and App
 * permissions sections the Workspace has, since both refer to the same installation.
 */
export function InstallationCard({ installationId }: { installationId: string }) {
  return (
    <div className="grid gap-3 rounded-xl border border-secondary p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold text-primary">{m.apps_installation_title()}</p>
        <Badge size="sm" color="success">
          {m.apps_installation_installed()}
        </Badge>
      </div>
      <div className="grid gap-1.5">
        <p className="text-sm text-tertiary">{m.apps_installation_id()}</p>
        <div className="flex items-center gap-1">
          <code className="min-w-0 break-all text-sm text-secondary">{installationId}</code>
          <CopyValueButton value={installationId} label={m.apps_copy_installation_id()} />
        </div>
        <p className="text-sm text-tertiary">{m.apps_installation_use()}</p>
      </div>
    </div>
  );
}
