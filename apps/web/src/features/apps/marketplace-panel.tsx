import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { CircleAlert } from "kubai-icons/duotone";

import { EmptyState, RetryButton } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { Skeleton } from "#src/components/ui/skeleton";
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
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [detail, setDetail] = useState<{ key?: string; open: boolean }>({ open: false });

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setApps(await load());
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
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
        <div
          role="status"
          aria-busy="true"
          aria-label={m.apps_marketplace_loading()}
          className={cn("gap-3", layout === "grid" ? "grid md:grid-cols-2" : "grid")}
        >
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      )}
      {loadFailed && (
        <EmptyState
          size="card"
          role="alert"
          picture={<EmptyIcon icon={CircleAlert} size="card" />}
          title={m.apps_marketplace_load_error()}
          primaryAction={
            <RetryButton size="card" isRetrying={loading} onPress={() => void refresh()} />
          }
        />
      )}
      {apps &&
        (shown.length === 0 ? (
          <AppsEmpty
            view="marketplace"
            filtered={apps.length > 0}
            query={query}
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
