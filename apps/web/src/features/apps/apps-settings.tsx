import { useCallback, useEffect, useId, useState } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Grid01, Link03, List, Plus, SearchLg } from "@untitledui/icons";
import { CircleAlert } from "kubai-icons/duotone";

import { Tab, TabList, TabPanel, Tabs } from "#src/components/application/tabs/tabs";
import { Badge } from "#src/components/base/badges/badges";
import { ButtonGroup, ButtonGroupItem } from "#src/components/base/button-group/button-group";
import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { Select } from "#src/components/base/select/select";
import { SelectItem } from "#src/components/base/select/select-item";
import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { EmptyState, RetryButton } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { Skeleton } from "#src/components/ui/skeleton";
import { canManageApps } from "#src/features/workspaces/workspace-roles";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { isAppErrorCode } from "#src/lib/app-error";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { AppCard } from "./app-card";
import { AppsEmpty } from "./apps-empty";
import { MarketplacePanel } from "./marketplace-panel";
import { AppDetail } from "./app-detail";
import { AppReviewLink } from "./app-review-link";
import { isPermissionsChanged } from "./app-form";
import { APP_CATEGORY_LABELS, filterApps } from "./app-list";
import { APP_CATEGORIES, type AppCategory } from "./app-category";
import { useAppsLayout } from "./apps-layout";
import { useRefreshOnFocus } from "./use-refresh-on-focus";
import { APPS_VIEWS, type AppsView } from "./apps-settings-search";
import { uninstallMarketplaceApp } from "./app-marketplace.functions";
import {
  approveWorkspaceAppPermissions,
  loadWorkspaceApps,
  type AppDeclarations,
  type AppSummary,
} from "./apps.functions";

const TAB_LABELS: Record<AppsView, () => string> = {
  installed: m.apps_tab_installed,
  mine: m.apps_tab_mine,
  marketplace: m.apps_tab_marketplace,
};

const settingsRoute = getRouteApi("/w/$workspaceSlug/settings");

export function AppsSettings({ actorRole }: { actorRole: string }) {
  const workspaceSlug = useWorkspaceSlug();
  const canManage = canManageApps(actorRole);
  const [apps, setApps] = useState<AppSummary[]>();
  const [declares, setDeclares] = useState<AppDeclarations>({
    permissions: false,
    setup: false,
    notifications: false,
    agentEvents: false,
    bot: false,
    reviewer: false,
  });
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const { appsTab: view = "installed", appsCategory: category = "all" } = settingsRoute.useSearch();
  const navigate = settingsRoute.useNavigate();
  const [query, setQuery] = useState("");
  const [layout, setLayout] = useAppsLayout();
  const [detail, setDetail] = useState<{ key?: string; open: boolean }>({ open: false });
  const titleId = useId();
  const load = useServerFn(loadWorkspaceApps);
  const approve = useServerFn(approveWorkspaceAppPermissions);
  const uninstall = useServerFn(uninstallMarketplaceApp);

  const read = useCallback(async () => {
    const loaded = await load();
    setApps(loaded.apps);
    setDeclares(loaded.declares);
  }, [load]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await read();
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [read]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const refreshSetup = read;
  useRefreshOnFocus(refreshSetup, apps?.some((app) => app.setup) ?? false);

  function showList(next: { view?: AppsView; category?: AppCategory | "all" }) {
    void navigate({
      search: (prev) => ({
        ...prev,
        ...("view" in next && { appsTab: next.view === "installed" ? undefined : next.view }),
        ...("category" in next && {
          appsCategory: next.category === "all" ? undefined : next.category,
        }),
      }),
      replace: true,
    });
  }

  function clearFilters() {
    setQuery("");
    showList({ category: "all" });
  }

  function openRegisterPage() {
    void navigate({
      to: "/w/$workspaceSlug/settings/apps/new",
      params: { workspaceSlug },
    });
  }

  function openEditPage(app: AppSummary) {
    void navigate({
      to: "/w/$workspaceSlug/settings/apps/$appKey",
      params: { workspaceSlug, appKey: app.key },
    });
  }

  async function refreshingWhenStale(action: () => Promise<void>) {
    try {
      await action();
    } catch (cause) {
      if (isAppErrorCode(cause, "NOT_FOUND")) void refresh();
      if (isPermissionsChanged(cause)) await refresh();
      throw cause;
    }
  }

  const approvePermissions = (app: AppSummary, revision: number) =>
    refreshingWhenStale(async () => {
      const permissions = await approve({ data: { key: app.key, revision } });
      setApps((current) =>
        current?.map((held) => (held.key === app.key ? { ...held, permissions } : held)),
      );
    });

  const uninstallApp = (app: AppSummary) =>
    refreshingWhenStale(async () => {
      await uninstall({ data: { key: app.key } });
      setDetail((prev) => ({ ...prev, open: false }));
      setApps((current) => current?.filter((held) => held.key !== app.key));
    });

  const all = apps ?? [];
  const mine = all.filter((app) => app.owned);
  const list = view === "mine" ? mine : all;
  const shown = filterApps(list, { query, category });
  const counts: Partial<Record<AppsView, number>> = { installed: all.length, mine: mine.length };

  return (
    <div className="w-full px-page pb-8">
      <section aria-labelledby={titleId} className="grid gap-4 py-6">
        <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h2 id={titleId} className="flex items-center gap-2 text-lg font-semibold text-primary">
            <Link03 aria-hidden="true" className="size-5 text-fg-quaternary" />
            {m.settings_applications()}
          </h2>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {declares.reviewer && <AppReviewLink />}
            {canManage && (
              <Button size="sm" color="primary" iconLeading={Plus} onPress={openRegisterPage}>
                {m.apps_register()}
              </Button>
            )}
          </div>
        </header>

        <Tabs
          selectedKey={view}
          onSelectionChange={(key) => {
            const next = APPS_VIEWS.find((candidate) => candidate === key);
            if (next) showList({ view: next });
          }}
        >
          <div className="grid gap-4 rounded-xl border border-secondary p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="grid gap-1">
                <h3 className="text-md font-semibold text-primary">{m.apps_card_title()}</h3>
                <p className="text-sm text-tertiary">
                  {canManage ? m.apps_card_description_manage() : m.apps_card_description_view()}
                </p>
                {!canManage && <p className="text-sm text-tertiary">{m.apps_admin_only_note()}</p>}
              </div>
              {loading && (
                <p role="status" className="shrink-0 text-sm text-tertiary">
                  {m.apps_loading()}
                </p>
              )}
            </div>
            <TabList
              type="button-border"
              size="sm"
              aria-label={m.apps_views_label()}
              className="w-max max-w-full"
            >
              {APPS_VIEWS.map((id) => (
                <Tab key={id} id={id}>
                  {TAB_LABELS[id]()}
                  {(counts[id] ?? 0) > 0 && (
                    <Badge size="sm" type="modern" color="gray" className="-my-px">
                      {counts[id]}
                    </Badge>
                  )}
                </Tab>
              ))}
            </TabList>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_14rem_auto]">
            <Input
              type="search"
              aria-label={m.apps_search_label()}
              placeholder={m.apps_search_placeholder()}
              icon={SearchLg}
              size="sm"
              value={query}
              onChange={setQuery}
            />
            <Select
              aria-label={m.apps_category_filter_label()}
              size="sm"
              value={category}
              onChange={(key) => {
                const next = APP_CATEGORIES.find((candidate) => candidate === key);
                showList({ category: next ?? "all" });
              }}
            >
              <SelectItem id="all" label={m.apps_category_all()} />
              {APP_CATEGORIES.map((id) => (
                <SelectItem key={id} id={id} label={APP_CATEGORY_LABELS[id]()} />
              ))}
            </Select>
            <ButtonGroup
              size="sm"
              aria-label={m.apps_layout_label()}
              selectionMode="single"
              disallowEmptySelection
              selectedKeys={[layout]}
              onSelectionChange={(keys) => {
                const [next] = [...keys];
                if (next === "grid" || next === "list") setLayout(next);
              }}
            >
              <Tooltip title={m.apps_layout_grid()}>
                <ButtonGroupItem id="grid" aria-label={m.apps_layout_grid()} iconLeading={Grid01} />
              </Tooltip>
              <Tooltip title={m.apps_layout_list()}>
                <ButtonGroupItem id="list" aria-label={m.apps_layout_list()} iconLeading={List} />
              </Tooltip>
            </ButtonGroup>
          </div>

          {loadFailed && (
            <div className="mt-4">
              <EmptyState
                size="card"
                role="alert"
                picture={<EmptyIcon icon={CircleAlert} size="card" />}
                title={m.apps_load_error()}
                primaryAction={
                  <RetryButton size="card" isRetrying={loading} onPress={() => void refresh()} />
                }
              />
            </div>
          )}

          {APPS_VIEWS.map((id) =>
            id === "marketplace" ? (
              <TabPanel key={id} id={id} className="mt-4 grid gap-3 outline-hidden">
                <MarketplacePanel
                  query={query}
                  category={category}
                  layout={layout}
                  canManage={canManage}
                  onInstalled={read}
                  onClearFilters={clearFilters}
                />
              </TabPanel>
            ) : (
              <TabPanel key={id} id={id} className="mt-4 grid gap-3 outline-hidden">
                {id === "mine" && (
                  <p className="text-sm text-tertiary">
                    {canManage ? m.apps_mine_intro_manage() : m.apps_mine_intro_view()}
                  </p>
                )}
                {!apps && loading && !loadFailed ? (
                  <div
                    role="status"
                    aria-busy="true"
                    aria-label={m.apps_loading()}
                    className={cn("gap-3", layout === "grid" ? "grid md:grid-cols-2" : "grid")}
                  >
                    <Skeleton className="h-24 w-full rounded-xl" />
                    <Skeleton className="h-24 w-full rounded-xl" />
                  </div>
                ) : apps && shown.length === 0 ? (
                  <AppsEmpty
                    view={id}
                    filtered={list.length > 0}
                    query={query}
                    canManage={canManage}
                    onRegister={canManage ? openRegisterPage : undefined}
                    onClearFilters={clearFilters}
                  />
                ) : (
                  <ul className={cn("gap-3", layout === "grid" ? "grid md:grid-cols-2" : "grid")}>
                    {shown.map((app) => (
                      <AppCard
                        key={app.key}
                        app={app}
                        view={id}
                        layout={layout}
                        onEdit={canManage && app.owned ? () => openEditPage(app) : undefined}
                        onOpen={
                          id === "installed"
                            ? () => setDetail({ key: app.key, open: true })
                            : undefined
                        }
                      />
                    ))}
                  </ul>
                )}
              </TabPanel>
            ),
          )}
        </Tabs>
      </section>

      <AppDetail
        open={detail.open}
        app={apps?.find((held) => held.key === detail.key)}
        declares={declares}
        canManage={canManage}
        onClose={() => setDetail((prev) => ({ ...prev, open: false }))}
        onApprovePermissions={approvePermissions}
        onRefreshSetup={refreshSetup}
        onUninstall={uninstallApp}
      />
    </div>
  );
}
