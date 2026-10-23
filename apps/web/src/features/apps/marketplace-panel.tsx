import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";

import { Button } from "#src/components/base/buttons/button";
import { Alert } from "#src/components/ui/alert";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { AppCategory } from "./app-category";
import { isPermissionsChanged } from "./app-form";
import { filterApps } from "./app-list";
import {
  installMarketplaceApp,
  loadMarketplaceApps,
  type MarketplaceApp,
} from "./app-marketplace.functions";
import { AppsEmpty } from "./apps-empty";
import type { AppsLayout } from "./apps-layout";
import { MarketplaceAppDetail } from "./marketplace-app-detail";
import { MarketplaceCard } from "./marketplace-listing";

/**
 * Settings → Applications → Marketplace: the apps other Workspaces published, searched and
 * filtered by the page's controls. It reads its own list when it opens. An install (owners and
 * admins) approves the declaration shown; a declaration that changed meanwhile reloads the list so
 * the dialog shows the current one, and `onInstalled` makes the page read its Installed list again.
 */
export function MarketplacePanel({
  query,
  category,
  layout,
  canManage,
  onInstalled,
  onClearFilters,
}: {
  query: string;
  category: AppCategory | "all";
  layout: AppsLayout;
  canManage: boolean;
  onInstalled: () => Promise<void>;
  onClearFilters: () => void;
}) {
  const load = useServerFn(loadMarketplaceApps);
  const install = useServerFn(installMarketplaceApp);
  const [apps, setApps] = useState<MarketplaceApp[]>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [detail, setDetail] = useState<{ key?: string; open: boolean }>({ open: false });

  const refresh = useCallback(async () => {
    try {
      setApps(await load());
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [load]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function installApp(app: MarketplaceApp) {
    try {
      await install({ data: { key: app.key, revision: app.permissionRevision } });
    } catch (cause) {
      if (isPermissionsChanged(cause)) await refresh();
      throw cause;
    }
    setApps((current) =>
      current?.map((held) =>
        held.key === app.key
          ? { ...held, installed: true, installCount: held.installCount + 1 }
          : held,
      ),
    );
    await onInstalled().catch(() => {});
  }

  const shown = filterApps(apps ?? [], { query, category });
  return (
    <>
      <p className="text-sm text-tertiary">
        {canManage ? m.apps_marketplace_intro_manage() : m.apps_marketplace_intro_view()}{" "}
        {m.apps_marketplace_review_note()}
      </p>
      {apps === undefined && !loadFailed && (
        <p role="status" className="text-sm text-tertiary">
          {m.apps_marketplace_loading()}
        </p>
      )}
      {loadFailed && (
        <Alert
          color="warning"
          title={m.apps_marketplace_load_error()}
          actions={
            <Button size="sm" color="secondary" onPress={() => void refresh()}>
              {m.controls_retry()}
            </Button>
          }
        />
      )}
      {apps &&
        (shown.length === 0 ? (
          <AppsEmpty
            view="marketplace"
            filtered={apps.length > 0}
            canManage={canManage}
            onClearFilters={onClearFilters}
          />
        ) : (
          <ul className={cn("gap-3", layout === "grid" ? "grid md:grid-cols-2" : "grid")}>
            {shown.map((app) => (
              <MarketplaceCard
                key={app.key}
                app={app}
                layout={layout}
                onOpen={() => setDetail({ key: app.key, open: true })}
              />
            ))}
          </ul>
        ))}
      <MarketplaceAppDetail
        open={detail.open}
        app={apps?.find((held) => held.key === detail.key)}
        canManage={canManage}
        onClose={() => setDetail((prev) => ({ ...prev, open: false }))}
        onInstall={installApp}
      />
    </>
  );
}
