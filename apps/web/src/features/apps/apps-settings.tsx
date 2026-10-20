import { useCallback, useEffect, useId, useState } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Grid01, Link03, List, Plus, SearchLg } from "@untitledui/icons";

import { Tab, TabList, TabPanel, Tabs } from "#src/components/application/tabs/tabs";
import { Badge } from "#src/components/base/badges/badges";
import { ButtonGroup, ButtonGroupItem } from "#src/components/base/button-group/button-group";
import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { Select } from "#src/components/base/select/select";
import { SelectItem } from "#src/components/base/select/select-item";
import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { Alert } from "#src/components/ui/alert";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#src/components/ui/empty";
import { canManageApps } from "#src/features/workspaces/workspace-roles";
import { isAppErrorCode } from "#src/lib/app-error";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { AppCard } from "./app-card";
import { AppEditor } from "./app-editor";
import { APP_CATEGORY_LABELS, filterApps } from "./app-list";
import { APP_CATEGORIES, type AppCategory } from "./app-category";
import type { AppRegistrationInput } from "./app-registration";
import { AppSecretPanel, type IssuedSecret } from "./app-secret-panel";
import { useAppsLayout } from "./apps-layout";
import { APPS_VIEWS, type AppsView } from "./apps-settings-search";
import {
  deleteWorkspaceApp,
  loadWorkspaceApps,
  registerWorkspaceApp,
  resetWorkspaceAppLogo,
  rotateWorkspaceAppSecret,
  uploadWorkspaceAppLogo,
  updateWorkspaceApp,
  type AppSummary,
} from "./apps.functions";

type EditorState = { mode: "register" } | { mode: "edit"; app: AppSummary };

const settingsRoute = getRouteApi("/w/$workspaceSlug/settings");

/**
 * Settings → Applications: the apps installed in this Workspace and the ones it registered, each
 * list searchable and filterable by category, as a grid or a list. The tab and the category are in
 * the page URL (`APPS_SETTINGS_SEARCH`). Owners and admins register an app and edit one in the
 * editor; everyone else reads. All feedback is inline: no toasts.
 */
export function AppsSettings({ actorRole }: { actorRole: string }) {
  const canManage = canManageApps(actorRole);
  const [apps, setApps] = useState<AppSummary[]>();
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const { appsTab: view = "installed", appsCategory: category = "all" } = settingsRoute.useSearch();
  const navigate = settingsRoute.useNavigate();
  const [query, setQuery] = useState("");
  const [layout, setLayout] = useAppsLayout();
  const [editor, setEditor] = useState<EditorState | null>(null);
  // Closing keeps `editor`, so the dialog keeps its words while it fades out.
  const [editorOpen, setEditorOpen] = useState(false);
  // A new client secret, shown once: on the page after a register, in the editor after a
  // regenerate. A new register, or opening another app, drops it.
  const [issued, setIssued] = useState<(IssuedSecret & { key: string }) | null>(null);
  const titleId = useId();
  const load = useServerFn(loadWorkspaceApps);
  const register = useServerFn(registerWorkspaceApp);
  const update = useServerFn(updateWorkspaceApp);
  const rotate = useServerFn(rotateWorkspaceAppSecret);
  const remove = useServerFn(deleteWorkspaceApp);
  const resetLogo = useServerFn(resetWorkspaceAppLogo);
  const uploadLogo = useServerFn(uploadWorkspaceAppLogo);

  /** Reads the apps again; a failed read keeps what is on screen, and the failure shows inline. */
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

  function openEditor(next: EditorState) {
    if (next.mode === "register" || next.app.key !== issued?.key) setIssued(null);
    setEditor(next);
    setEditorOpen(true);
  }

  async function submit(input: AppRegistrationInput) {
    if (editor?.mode === "edit") {
      // The key is the app's client ID: never part of a change.
      const { key: _key, ...patch } = input;
      const { key } = editor.app;
      await refreshingOnNotFound(async () => {
        const app = await update({ data: { key, patch } });
        setEditorOpen(false);
        setApps((current) => current?.map((held) => (held.key === app.key ? app : held)));
      });
      return;
    }
    const { app, clientSecret } = await register({ data: input });
    setEditorOpen(false);
    showList({ view: "mine" });
    setIssued({ key: app.key, appName: app.name, secret: clientSecret });
    await refresh();
  }

  /** A change on an app that is already gone leaves this list behind: read it again. */
  async function refreshingOnNotFound(action: () => Promise<void>) {
    try {
      await action();
    } catch (cause) {
      if (isAppErrorCode(cause, "NOT_FOUND")) void refresh();
      throw cause;
    }
  }

  const regenerate = (app: AppSummary) =>
    refreshingOnNotFound(async () => {
      const { clientSecret } = await rotate({ data: { key: app.key } });
      setIssued({ key: app.key, appName: app.name, secret: clientSecret });
    });

  const deleteApp = (app: AppSummary) =>
    refreshingOnNotFound(async () => {
      await remove({ data: { key: app.key } });
      setEditorOpen(false);
      setIssued(null);
      setApps((current) => current?.filter((held) => held.key !== app.key));
    });

  /** A logo change is made at once: the list and the open editor show it. */
  function showLogo(key: string, logoUrl: string | null) {
    setApps((current) => current?.map((held) => (held.key === key ? { ...held, logoUrl } : held)));
    setEditor((current) =>
      current?.mode === "edit" && current.app.key === key
        ? { mode: "edit", app: { ...current.app, logoUrl } }
        : current,
    );
  }

  const uploadAppLogo = (app: AppSummary, file: File) =>
    refreshingOnNotFound(async () => {
      const form = new FormData();
      form.set("key", app.key);
      form.set("file", file);
      showLogo(app.key, (await uploadLogo({ data: form })).logoUrl);
    });

  const resetAppLogo = (app: AppSummary) =>
    refreshingOnNotFound(async () => {
      showLogo(app.key, (await resetLogo({ data: { key: app.key } })).logoUrl);
    });

  const all = apps ?? [];
  const shown = filterApps(all, { query, category });
  // Phase 1: a Workspace installs only the apps it registered, so both lists hold the same apps.
  const counts: Record<AppsView, number> = { installed: all.length, mine: all.length };
  const editing = editor?.mode === "edit" ? editor.app : undefined;

  return (
    <div className="w-full px-page pb-8">
      <section aria-labelledby={titleId} className="grid gap-4 py-6">
        <header className="flex items-center justify-between gap-4">
          <h2 id={titleId} className="flex items-center gap-2 text-lg font-semibold text-primary">
            <Link03 aria-hidden="true" className="size-5 text-fg-quaternary" />
            {m.settings_applications()}
          </h2>
          {canManage && (
            <Button
              size="sm"
              color="primary"
              iconLeading={Plus}
              onPress={() => openEditor({ mode: "register" })}
            >
              {m.apps_register()}
            </Button>
          )}
        </header>

        <Tabs
          selectedKey={view}
          onSelectionChange={(key) => {
            const next = APPS_VIEWS.find((candidate) => candidate === key);
            if (next) showList({ view: next });
          }}
        >
          <div className="grid gap-4 rounded-xl border border-secondary p-4 shadow-xs">
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
                  {/* The tab's own badge hides below `md`; this one stays at every width. */}
                  {id === "installed" ? m.apps_tab_installed() : m.apps_tab_mine()}
                  {counts[id] > 0 && (
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

          {loadFailed && !editorOpen && (
            <div className="mt-4">
              <Alert
                color="warning"
                title={m.apps_load_error()}
                actions={
                  <Button size="sm" color="secondary" onPress={() => void refresh()}>
                    {m.controls_retry()}
                  </Button>
                }
              />
            </div>
          )}

          {canManage && issued && !editorOpen && (
            <div className="mt-4">
              <AppSecretPanel issued={issued} />
            </div>
          )}

          {APPS_VIEWS.map((id) => (
            <TabPanel key={id} id={id} className="mt-4 grid gap-3 outline-hidden">
              {id === "mine" && (
                <p className="text-sm text-tertiary">
                  {canManage ? m.apps_mine_intro_manage() : m.apps_mine_intro_view()}
                </p>
              )}
              {apps && shown.length === 0 ? (
                <AppsEmpty
                  view={id}
                  filtered={all.length > 0}
                  canManage={canManage}
                  onRegister={() => openEditor({ mode: "register" })}
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
                      onEdit={canManage ? () => openEditor({ mode: "edit", app }) : undefined}
                    />
                  ))}
                </ul>
              )}
            </TabPanel>
          ))}
        </Tabs>
      </section>

      {canManage && (
        <AppEditor
          open={editorOpen}
          app={editing}
          issued={issued && editing && issued.key === editing.key ? issued : null}
          onClose={() => setEditorOpen(false)}
          onSubmit={submit}
          onRegenerate={regenerate}
          onDelete={deleteApp}
          onUploadLogo={uploadAppLogo}
          onResetLogo={resetAppLogo}
        />
      )}
    </div>
  );
}

/**
 * A tab with no app to show: none yet (with Register for an owner or admin, second to the page's
 * own button), or none matching the search and category (with a way back to every app).
 */
function AppsEmpty({
  view,
  filtered,
  canManage,
  onRegister,
  onClearFilters,
}: {
  view: AppsView;
  filtered: boolean;
  canManage: boolean;
  onRegister: () => void;
  onClearFilters: () => void;
}) {
  const Icon = filtered ? SearchLg : Link03;
  const title = filtered
    ? view === "installed"
      ? m.apps_installed_no_match()
      : m.apps_mine_no_match()
    : view === "installed"
      ? m.apps_installed_empty_title()
      : m.apps_mine_empty_title();
  const description = filtered
    ? m.apps_no_match_description()
    : view === "installed"
      ? canManage
        ? m.apps_installed_empty_description_manage()
        : m.apps_installed_empty_description_view()
      : canManage
        ? m.apps_mine_empty_description_manage()
        : m.apps_mine_empty_description_view();
  return (
    <Empty className="max-w-none rounded-xl border border-dashed border-secondary px-4 py-10">
      <EmptyHeader className="mb-4 gap-2">
        <EmptyMedia className="mb-2">
          <Icon aria-hidden="true" className="size-8 text-tertiary" strokeWidth={1.5} />
        </EmptyMedia>
        <EmptyTitle role="heading" aria-level={3}>
          {title}
        </EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {(filtered || canManage) && (
        <EmptyContent>
          {filtered ? (
            <Button size="sm" color="secondary" onPress={onClearFilters}>
              {m.apps_clear_filters()}
            </Button>
          ) : (
            <Button size="sm" color="secondary" iconLeading={Plus} onPress={onRegister}>
              {m.apps_register()}
            </Button>
          )}
        </EmptyContent>
      )}
    </Empty>
  );
}
