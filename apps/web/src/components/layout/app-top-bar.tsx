import type { ReactNode } from "react";
import { LayoutLeft } from "@untitledui/icons";

import { CoForgeMark } from "#src/components/foundations/logo/coforge-mark";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { SIDEBAR_WIDTH_CLASS } from "#src/components/layout/sidebar/sidebar-expanded";
import { writeSidebarExpanded } from "#src/features/settings/sidebar-expanded";
import { SidebarToggleTooltip } from "#src/features/settings/sidebar-shortcut";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";

/** The desktop bar across the top of the window: where you are on the left, search in the middle
 * with the busy Agents just before it, what concerns you on the right. Phones have no room for it;
 * their pages keep their own header. */
export function AppTopBar({
  workspace,
  agents,
  search,
  end,
}: {
  workspace: ReactNode;
  /** Who is working right now, ending at the search field's left edge. */
  agents: ReactNode;
  search: ReactNode;
  end: ReactNode;
}) {
  return (
    // Equal side columns center the search field on the window, whatever each side holds. Below
    // `xl` the field narrows so the busy Agents keep room for three mascots beside the sidebar zone.
    <header className="hidden h-12 shrink-0 grid-cols-[minmax(0,1fr)_minmax(0,20rem)_minmax(0,1fr)] items-center gap-3 lg:grid xl:grid-cols-[minmax(0,1fr)_minmax(0,30rem)_minmax(0,1fr)]">
      <div className="flex min-w-0 items-center">
        {/* Exactly as wide as the expanded sidebar and on the nav icons' axis, so the toggle ends
        where the sidebar does; widening the sidebar gives a long Workspace name room. */}
        <div
          className={cx("flex min-w-0 shrink-0 items-center gap-2 pr-3 pl-6", SIDEBAR_WIDTH_CLASS)}
        >
          <CoForgeMark className="size-5 shrink-0" />
          <div className="flex min-w-0">{workspace}</div>
          <SidebarToggle />
        </div>
        <div className="flex min-w-0 flex-1 justify-end">{agents}</div>
      </div>
      {search}
      <div className="flex min-w-0 items-center justify-end gap-2 pr-4">{end}</div>
    </header>
  );
}

/** Collapses or expands the sidebar from above its edge, the same spot in both states. Both buttons
 * render; the `sidebar-collapsed` class on <html> picks one, as it picks the sidebar. */
function SidebarToggle() {
  return (
    <span className="ml-auto flex shrink-0">
      <Tooltip title={<SidebarToggleTooltip label={m.navigation_collapse_sidebar()} />}>
        <ButtonUtility
          icon={LayoutLeft}
          size="sm"
          color="tertiary"
          aria-label={m.navigation_collapse_sidebar()}
          onClick={() => writeSidebarExpanded(false)}
          className="[.sidebar-collapsed_&]:hidden"
        />
      </Tooltip>
      <Tooltip title={<SidebarToggleTooltip label={m.navigation_expand_sidebar()} />}>
        <ButtonUtility
          icon={LayoutLeft}
          size="sm"
          color="tertiary"
          aria-label={m.navigation_expand_sidebar()}
          onClick={() => writeSidebarExpanded(true)}
          className="[html:not(.sidebar-collapsed)_&]:hidden"
        />
      </Tooltip>
    </span>
  );
}
