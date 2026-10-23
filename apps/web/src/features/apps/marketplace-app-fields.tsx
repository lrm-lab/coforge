import { Badge } from "#src/components/base/badges/badges";
import { m } from "#src/paraglide/messages";
import { HomepageLink, LoginScopeList } from "./app-dialog-parts";
import type { MarketplaceAppInfo } from "./app-marketplace.functions";
import { APP_NOTIFICATION_EVENT_LABELS } from "./app-notification-copy";
import { APP_NOTIFICATION_EVENT_NAMES } from "./app-notification-events";
import { APP_PERMISSION_GROUP_COPY } from "./app-permission-copy";
import { APP_PERMISSION_GROUPS } from "./app-permissions";

/**
 * What an install of `app` shows and approves: description, developer, homepage and callback
 * domains, the Login with CoForge scopes, the data it reads and the notification events it
 * subscribes to. The Marketplace detail dialog and the private share page draw it alike.
 */
export function MarketplaceAppFields({ app }: { app: MarketplaceAppInfo }) {
  const groups = APP_PERMISSION_GROUPS.filter((g) => app.permissionGroups.includes(g));
  const events = APP_NOTIFICATION_EVENT_NAMES.filter((e) => app.notificationEvents.includes(e));
  return (
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
    </>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
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
