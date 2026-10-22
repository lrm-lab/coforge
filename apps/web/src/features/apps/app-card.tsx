import { Edit05, LinkExternal01 } from "@untitledui/icons";
import { Link as AriaLink } from "react-aria-components";

import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { permissionGroupList } from "./app-permission-copy";
import { APP_CATEGORY_LABELS } from "./app-list";
import { AppLogo } from "./app-logo";
import { SetupDirections, SetupStatusBadge } from "./setup-status-badge";
import type { AppsLayout } from "./apps-layout";
import type { AppSummary } from "./apps.functions";

/**
 * One app on Settings → Applications. `installed`: as the Installed list shows it (where it comes
 * from, its visibility and that it is this Workspace's own); `mine`: as My apps shows it. The grid
 * shows the homepage when the app has one; the list the description, clamped to two lines with all
 * of it in a tooltip. Where the app's data permissions are shown (`app-data-permissions`), every
 * member sees what it reads here and whether an update waits for approval. `onEdit` only for an
 * owner or admin.
 */
export function AppCard({
  app,
  view,
  layout,
  onEdit,
}: {
  app: AppSummary;
  view: "installed" | "mine";
  layout: AppsLayout;
  onEdit?: () => void;
}) {
  const category = APP_CATEGORY_LABELS[app.category]();
  const installationSetup = app.setup?.installation;
  const homepage = app.homepageUrl === null ? null : new URL(app.homepageUrl);
  return (
    <li
      className={cn(
        "flex gap-3 rounded-xl border border-secondary bg-primary p-4",
        layout === "grid" ? "min-h-40 flex-col" : "items-start",
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <AppLogo name={app.name} url={app.logoUrl} size={layout === "grid" ? "md" : "sm"} />
        <div className="grid min-w-0 flex-1 gap-1">
          <p className="truncate text-sm font-semibold text-primary">{app.name}</p>
          <p className="truncate text-sm text-tertiary">
            {view === "installed" ? m.apps_installed_byline({ category }) : category}
          </p>
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            <Badge size="sm" color="gray">
              {m.apps_private_badge()}
            </Badge>
            {view === "installed" && (
              <Badge size="sm" color="gray">
                {m.apps_this_workspace()}
              </Badge>
            )}
            {installationSetup && installationSetup.status !== "not_required" && (
              <SetupStatusBadge status={installationSetup.status} />
            )}
            {app.permissions && app.permissions.pending.length > 0 && (
              <Badge size="sm" color="warning">
                {m.apps_card_pending()}
              </Badge>
            )}
          </div>
          {app.permissions && app.permissions.effective.length > 0 && (
            <p className="text-sm text-tertiary">
              {m.apps_card_reads({ groups: permissionGroupList(app.permissions.effective) })}
            </p>
          )}
          {!onEdit && installationSetup?.status === "pending" && app.setup?.url && (
            <div className="grid gap-1">
              <SetupDirections url={app.setup.url} description={app.setup.description} />
              <p className="text-sm text-tertiary">{m.apps_setup_member_note()}</p>
            </div>
          )}
          {layout === "list" && app.description && (
            <Tooltip title={app.description} placement="bottom start">
              <TooltipTrigger className="mt-1 w-full cursor-default rounded-sm text-left outline-focus-ring focus-visible:outline-2">
                <span className="line-clamp-2 text-sm break-words whitespace-pre-line text-secondary">
                  {app.description}
                </span>
              </TooltipTrigger>
            </Tooltip>
          )}
        </div>
      </div>
      <div
        className={cn(
          "flex min-w-0 items-center gap-3",
          layout === "grid"
            ? cn("mt-auto", homepage ? "justify-between" : "justify-end")
            : "shrink-0",
        )}
      >
        {layout === "grid" && homepage && (
          <Tooltip title={homepage.href}>
            <AriaLink
              href={homepage.href}
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-w-0 items-center gap-1 rounded-sm text-sm text-secondary outline-focus-ring hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              <LinkExternal01 aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="truncate font-mono text-xs underline underline-offset-4">
                {homepage.host}
              </span>
            </AriaLink>
          </Tooltip>
        )}
        {onEdit && (
          <Button
            size="sm"
            color="secondary"
            iconLeading={Edit05}
            aria-label={m.apps_edit_label({ name: app.name })}
            onPress={onEdit}
          >
            {m.apps_edit()}
          </Button>
        )}
      </div>
    </li>
  );
}
