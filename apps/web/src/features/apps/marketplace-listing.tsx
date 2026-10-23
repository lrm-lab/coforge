import { LinkExternal01 } from "@untitledui/icons";

import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { APP_CATEGORY_LABELS } from "./app-list";
import { AppLogo } from "./app-logo";
import type { MarketplaceApp } from "./app-marketplace.functions";
import type { AppsLayout } from "./apps-layout";

/** One published app in the Marketplace tab: who made it, what it is and whether this Workspace
 * has it. The name opens the detail where it is installed. */
export function MarketplaceCard({
  app,
  layout,
  onOpen,
}: {
  app: MarketplaceApp;
  layout: AppsLayout;
  onOpen: () => void;
}) {
  return (
    <li
      className={cn(
        "flex gap-3 rounded-xl border border-secondary bg-primary p-4",
        layout === "grid" ? "min-h-40 flex-col" : "items-start",
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <AppLogo name={app.name} url={app.logoUrl} size={layout === "grid" ? "md" : "sm"} />
        <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] gap-1">
          <Button
            color="link-gray"
            size="sm"
            aria-label={m.apps_marketplace_open_label({ name: app.name })}
            onPress={onOpen}
            className="w-fit max-w-full min-w-0 justify-start font-semibold text-primary *:data-text:truncate"
          >
            {app.name}
          </Button>
          <p className="truncate text-sm text-tertiary">
            {m.apps_marketplace_byline({
              category: APP_CATEGORY_LABELS[app.category](),
              developer: app.developer,
            })}
          </p>
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            {app.installed && (
              <Badge size="sm" color="success">
                {m.apps_marketplace_installed()}
              </Badge>
            )}
            <span className="text-xs text-tertiary">
              {m.apps_marketplace_installs({ count: app.installCount })}
            </span>
          </div>
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
      {layout === "grid" && app.homepageHost && (
        <p className="mt-auto flex min-w-0 items-center gap-1 text-sm text-secondary">
          <LinkExternal01 aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate font-mono text-xs">{app.homepageHost}</span>
        </p>
      )}
    </li>
  );
}
