import { Plus } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { EmptyState } from "#src/components/ui/empty";
import { GalleryWireframe, NoResultsWireframe } from "#src/components/ui/empty-wireframes";
import { m } from "#src/paraglide/messages";
import type { AppsView } from "./apps-settings-search";

const EMPTY_COPY = {
  installed: {
    title: m.apps_installed_empty_title,
    noMatch: m.apps_installed_no_match,
    manage: m.apps_installed_empty_description_manage,
    view: m.apps_installed_empty_description_view,
  },
  mine: {
    title: m.apps_mine_empty_title,
    noMatch: m.apps_mine_no_match,
    manage: m.apps_mine_empty_description_manage,
    view: m.apps_mine_empty_description_view,
  },
  marketplace: {
    title: m.apps_marketplace_empty_title,
    noMatch: m.apps_marketplace_no_match,
    manage: m.apps_marketplace_empty_description,
    view: m.apps_marketplace_empty_description,
  },
} as const;

export function AppsEmpty({
  view,
  filtered,
  query,
  canManage,
  onRegister,
  onClearFilters,
}: {
  view: AppsView;
  filtered: boolean;
  query?: string;
  canManage: boolean;
  onRegister?: () => void;
  onClearFilters: () => void;
}) {
  const copy = EMPTY_COPY[view];
  const trimmed = query?.trim() ?? "";
  const title = filtered
    ? trimmed
      ? m.empty_apps_no_match_query({ query: trimmed })
      : copy.noMatch()
    : copy.title();
  const description = filtered
    ? m.apps_no_match_description()
    : canManage
      ? copy.manage()
      : copy.view();
  return (
    <EmptyState
      size="page"
      headingLevel={3}
      live={filtered ? "polite" : undefined}
      className="max-w-none rounded-xl border border-dashed border-secondary px-4 py-10"
      picture={
        filtered ? (
          <NoResultsWireframe />
        ) : (
          <GalleryWireframe accent={Boolean(onRegister && canManage)} />
        )
      }
      title={title}
      description={description}
      primaryAction={
        filtered ? (
          <Button size="sm" color="secondary" onPress={onClearFilters}>
            {m.apps_clear_filters()}
          </Button>
        ) : onRegister ? (
          <Button size="sm" iconLeading={Plus} onPress={onRegister}>
            {m.apps_register()}
          </Button>
        ) : undefined
      }
    />
  );
}
