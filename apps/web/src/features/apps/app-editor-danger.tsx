import { useState } from "react";
import { RefreshCw01, Trash01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import { isAppErrorCode } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import { appFormProblem } from "./app-form";
import { canDeleteApp } from "./app-publish-status";
import type { AppSummary } from "./apps.functions";

type DangerAction = "regenerate" | "delete" | "unpublish";

/** The confirmation each danger-zone action asks for, and what its failure says. */
const CONFIRM_COPY: Record<
  DangerAction,
  {
    title: (app: AppSummary) => string;
    description: (app: AppSummary) => string;
    confirmLabel: () => string;
    pendingLabel: () => string;
    failed: () => string;
  }
> = {
  regenerate: {
    title: (app) => m.apps_regenerate_title({ name: app.name }),
    description: (app) => m.apps_regenerate_description({ key: app.key }),
    confirmLabel: m.apps_regenerate_secret,
    pendingLabel: m.apps_regenerating,
    failed: m.apps_regenerate_error,
  },
  unpublish: {
    title: (app) => m.apps_publish_offline_title({ name: app.name }),
    description: (app) => m.apps_publish_offline_description({ key: app.key }),
    confirmLabel: m.apps_publish_offline,
    pendingLabel: m.apps_publish_offline_pending_label,
    failed: m.apps_publish_offline_error,
  },
  delete: {
    title: (app) => m.apps_delete_title({ name: app.name }),
    description: (app) => m.apps_delete_description({ key: app.key }),
    confirmLabel: m.apps_delete_submit,
    pendingLabel: m.apps_deleting,
    failed: m.apps_delete_error,
  },
};

/**
 * The editor's danger zone: regenerating the client secret, asking for a published app to go
 * offline (`onRequestUnpublish`, only where `app-marketplace` is on and the app is published) and
 * deleting the app, which a published app cannot be. Each acts at once after its own
 * confirmation, apart from the form's Save.
 */
export function DangerZoneRows({
  app,
  isDisabled,
  onRegenerate,
  onDelete,
  onRequestUnpublish,
}: {
  app: AppSummary;
  isDisabled: boolean;
  /** Each throws when the server refuses it. */
  onRegenerate: () => Promise<void>;
  onDelete: () => Promise<void>;
  onRequestUnpublish?: () => Promise<void>;
}) {
  const [action, setAction] = useState<DangerAction>("regenerate");
  const [open, setOpen] = useState(false);
  const confirm = (next: DangerAction) => {
    setAction(next);
    setOpen(true);
  };
  const copy = CONFIRM_COPY[action];
  const runs: Record<DangerAction, (() => Promise<void>) | undefined> = {
    regenerate: onRegenerate,
    unpublish: onRequestUnpublish,
    delete: onDelete,
  };
  return (
    <>
      <div className="divide-y divide-secondary rounded-xl border border-secondary">
        <DangerRow
          title={m.apps_danger_secret_title()}
          description={m.apps_danger_secret_description()}
          action={
            <Button
              size="sm"
              color="secondary-destructive"
              iconLeading={RefreshCw01}
              isDisabled={isDisabled}
              onPress={() => confirm("regenerate")}
            >
              {m.apps_regenerate_secret()}
            </Button>
          }
        />
        {onRequestUnpublish && app.publishStatus === "published" && (
          <DangerRow
            title={m.apps_publish_lifecycle_title()}
            description={m.apps_publish_lifecycle_description()}
            action={
              <Button
                size="sm"
                color="secondary-destructive"
                isDisabled={isDisabled}
                onPress={() => confirm("unpublish")}
              >
                {m.apps_publish_offline()}
              </Button>
            }
          />
        )}
        {canDeleteApp(app.publishStatus) && (
          <DangerRow
            title={m.apps_danger_delete_title()}
            description={m.apps_danger_delete_description()}
            action={
              <Button
                size="sm"
                color="secondary-destructive"
                iconLeading={Trash01}
                isDisabled={isDisabled}
                onPress={() => confirm("delete")}
              >
                {m.apps_delete()}
              </Button>
            }
          />
        )}
      </div>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={copy.title(app)}
        description={copy.description(app)}
        confirmLabel={copy.confirmLabel()}
        pendingLabel={copy.pendingLabel()}
        errorMessage={(cause) =>
          isAppErrorCode(cause, "ACCESS_DENIED", "NOT_FOUND")
            ? appFormProblem(cause).message
            : copy.failed()
        }
        onConfirm={async () => {
          await runs[action]?.();
          setOpen(false);
        }}
      />
    </>
  );
}

function DangerRow({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="grid min-w-0 gap-1">
        <p className="text-sm font-medium text-primary">{title}</p>
        <p className="text-sm text-tertiary">{description}</p>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}
