import { useState } from "react";

import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { Alert } from "#src/components/ui/alert";
import { m } from "#src/paraglide/messages";
import {
  AppDialogShell,
  DialogCloseButton,
  HomepageLink,
  LoginScopeList,
} from "./app-dialog-parts";
import { isPermissionsChanged } from "./app-form";
import type { MarketplaceApp } from "./app-marketplace.functions";
import { APP_NOTIFICATION_EVENT_LABELS } from "./app-notification-copy";
import { APP_NOTIFICATION_EVENT_NAMES } from "./app-notification-events";
import { APP_PERMISSION_GROUP_COPY } from "./app-permission-copy";
import { APP_PERMISSION_GROUPS } from "./app-permissions";

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

  const groups = app ? APP_PERMISSION_GROUPS.filter((g) => app.permissionGroups.includes(g)) : [];
  const events = app
    ? APP_NOTIFICATION_EVENT_NAMES.filter((e) => app.notificationEvents.includes(e))
    : [];
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
          <p className="text-sm wrap-anywhere whitespace-pre-line text-secondary">
            {app.description || m.apps_detail_no_description()}
          </p>
          <Field label={m.apps_marketplace_developer()}>
            <span className="text-sm wrap-anywhere text-secondary">{app.developer}</span>
          </Field>
          {app.homepageUrl && app.homepageHost && (
            <Field label={m.apps_marketplace_homepage()}>
              <HomepageLink href={app.homepageUrl} host={app.homepageHost} />
            </Field>
          )}
          <Field label={m.apps_marketplace_callbacks()}>
            {app.callbackDomains.length === 0 ? (
              <span className="text-sm text-secondary">{m.apps_marketplace_callbacks_none()}</span>
            ) : (
              <ul className="grid gap-1">
                {app.callbackDomains.map((domain) => (
                  <li key={domain} className="font-mono text-xs wrap-anywhere text-secondary">
                    {domain}
                  </li>
                ))}
              </ul>
            )}
          </Field>
          <Field label={m.apps_marketplace_scopes()}>
            <LoginScopeList allowedScopes={app.allowedScopes} />
          </Field>
          <Field label={m.apps_marketplace_data()}>
            <Badges
              items={groups.map((group) => APP_PERMISSION_GROUP_COPY[group].label())}
              none={m.apps_marketplace_data_none()}
            />
          </Field>
          <Field label={m.apps_marketplace_events()}>
            <Badges
              items={events.map((event) => APP_NOTIFICATION_EVENT_LABELS[event]())}
              none={m.apps_marketplace_events_none()}
            />
          </Field>
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-1.5">
      <h3 className="text-sm text-tertiary">{label}</h3>
      {children}
    </section>
  );
}

function Badges({ items, none }: { items: readonly string[]; none: string }) {
  if (items.length === 0) return <span className="text-sm text-secondary">{none}</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <Badge key={item} size="sm" color="gray">
          {item}
        </Badge>
      ))}
    </div>
  );
}
