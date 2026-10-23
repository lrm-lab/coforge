import { useState } from "react";

import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { Alert } from "#src/components/ui/alert";
import { m } from "#src/paraglide/messages";
import { AppDialogShell, DialogCloseButton } from "./app-dialog-parts";
import { isPermissionsChanged } from "./app-form";
import type { MarketplaceApp } from "./app-marketplace.functions";
import { MarketplaceAppFields } from "./marketplace-app-fields";

/**
 * A published app's detail with what installing it approves: who made it, its homepage and
 * callback domains, the scopes Login with CoForge lets it ask for, the data it reads and the
 * notification events it subscribes to. An owner or admin (`canManage`) installs it here; the
 * install approves exactly the declaration shown, so one that changed meanwhile installs nothing
 * and the list updates (the dialog says so).
 */
export function MarketplaceAppDetail({
  open,
  app,
  canManage,
  onClose,
  onInstall,
}: {
  open: boolean;
  /** The listing as the tab now holds it; kept while the dialog fades out. */
  app: MarketplaceApp | undefined;
  canManage: boolean;
  onClose: () => void;
  /** Installs the app at the revision shown; throws when the server refuses. */
  onInstall: (app: MarketplaceApp) => Promise<void>;
}) {
  const [installing, setInstalling] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function install(listing: MarketplaceApp) {
    setInstalling(true);
    setProblem(null);
    try {
      await onInstall(listing);
    } catch (cause) {
      setProblem(
        isPermissionsChanged(cause)
          ? m.apps_marketplace_install_changed()
          : m.apps_marketplace_install_error(),
      );
    } finally {
      setInstalling(false);
    }
  }

  function close() {
    setProblem(null);
    onClose();
  }
  return (
    <AppDialogShell
      open={open}
      onClose={close}
      eyebrow={m.apps_marketplace_eyebrow()}
      app={app}
      badges={
        app?.installed && (
          <Badge size="sm" color="success">
            {m.apps_marketplace_installed()}
          </Badge>
        )
      }
      footer={
        app && (
          <>
            <DialogCloseButton label={m.apps_marketplace_close()} onClose={close} />
            {canManage && !app.installed && (
              <Button
                type="button"
                size="sm"
                color="primary"
                isLoading={installing}
                showTextWhileLoading
                isDisabled={installing}
                onPress={() => void install(app)}
              >
                {installing ? m.apps_marketplace_installing() : m.apps_marketplace_install()}
              </Button>
            )}
          </>
        )
      }
    >
      {app && (
        <>
          <MarketplaceAppFields app={app} />
          {canManage && !app.installed && app.approvesOnInstall && (
            <p className="text-sm text-tertiary">{m.apps_marketplace_install_records()}</p>
          )}
          {!canManage && !app.installed && (
            <p className="text-sm text-tertiary">{m.apps_marketplace_install_members_note()}</p>
          )}
          {app.installed && (
            <p className="text-sm text-tertiary">{m.apps_marketplace_installed_note()}</p>
          )}
          {problem && <Alert color="warning" title={problem} />}
        </>
      )}
    </AppDialogShell>
  );
}
