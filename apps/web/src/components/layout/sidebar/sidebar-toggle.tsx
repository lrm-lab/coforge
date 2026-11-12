import { LayoutLeft } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { writeSidebarExpanded } from "#src/features/settings/sidebar-expanded";
import { SidebarToggleTooltip } from "#src/features/settings/sidebar-shortcut";
import { m } from "#src/paraglide/messages";

/** Collapses the expanded sidebar from its top row, or expands the rail from its top. */
export function SidebarToggle({ expand = false }: { expand?: boolean }) {
  const label = expand ? m.navigation_expand_sidebar() : m.navigation_collapse_sidebar();
  return (
    <Tooltip
      title={<SidebarToggleTooltip label={label} />}
      placement={expand ? "right" : undefined}
    >
      <ButtonUtility
        icon={LayoutLeft}
        size="sm"
        color="tertiary"
        aria-label={label}
        onClick={() => writeSidebarExpanded(expand)}
      />
    </Tooltip>
  );
}
