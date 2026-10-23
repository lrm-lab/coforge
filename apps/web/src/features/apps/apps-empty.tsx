import { Link03, Plus, SearchLg } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#src/components/ui/empty";
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

/**
 * A tab with no app to show: none yet (with Register for an owner or admin, second to the page's
 * own button, only where `onRegister` is given), or none matching the search and category (with a way
 * back to every app).
 */
export function AppsEmpty({
  view,
  filtered,
  canManage,
  onRegister,
  onClearFilters,
}: {
  view: AppsView;
  filtered: boolean;
  canManage: boolean;
  /** Offers Register where there is nothing yet; omitted where registering is not the way out. */
  onRegister?: () => void;
  onClearFilters: () => void;
}) {
  const copy = EMPTY_COPY[view];
  const Icon = filtered ? SearchLg : Link03;
  const title = filtered ? copy.noMatch() : copy.title();
  const description = filtered
    ? m.apps_no_match_description()
    : canManage
      ? copy.manage()
      : copy.view();
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
      {(filtered || onRegister) && (
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
