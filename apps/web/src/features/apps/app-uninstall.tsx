import { useState } from "react";

import { Button } from "#src/components/base/buttons/button";
import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import { m } from "#src/paraglide/messages";
import type { AppSummary } from "./apps.functions";

/**
 * The detail's uninstall row for an app another Workspace owns (an owner or admin; the Workspace's
 * own app is deleted in its editor instead): after a confirmation the app and its grants and tokens
 * in this Workspace are gone.
 */
export function UninstallRow({
  app,
  onUninstall,
}: {
  app: AppSummary;
  /** Uninstalls the app; throws when the server refuses. */
  onUninstall: (app: AppSummary) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-secondary p-4">
      <p className="min-w-0 flex-1 text-sm text-tertiary">{m.apps_uninstall_summary()}</p>
      <Button type="button" size="sm" color="secondary-destructive" onPress={() => setOpen(true)}>
        {m.apps_uninstall()}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={m.apps_uninstall_title({ name: app.name })}
        description={m.apps_uninstall_description({ name: app.name })}
        confirmLabel={m.apps_uninstall_confirm()}
        pendingLabel={m.apps_uninstalling()}
        errorMessage={m.apps_uninstall_error()}
        onConfirm={() => onUninstall(app)}
      />
    </section>
  );
}
