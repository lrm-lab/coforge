import type { ComponentMeta } from "#src/components/ui/component-meta";
import { CASCADE_MENU_TIMINGS } from "#src/lib/cascade-menu-safe-zone";

export const dropdownSubmenuMeta: ComponentMeta = {
  component: "Dropdown.SubmenuTrigger",
  overlayKind: "click-menu",
  whenToUse: [
    "Secondary action/choice menus opened on click/keyboard with openOnHover={false}",
    "Read-only glance submenus inside an already-open menu (such as Seen By) with openOnHover={true} and safe-zone triangle protection",
  ],
  whenNotToUse: [
    {
      when: "A submenu contains a search field, text input, or multi-select filter (such as PickerMenu)",
      why: "Hover opening steals focus on autoFocus and pointer drift discards typed input",
      instead: "Dropdown.SubmenuTrigger with openOnHover={false}",
    },
    {
      when: "A choice or action submenu that changes settings or triggers commands",
      why: "Menus that are a choice rather than a glance should open explicitly on click or keyboard",
      instead: "Dropdown.SubmenuTrigger with openOnHover={false}",
    },
    {
      when: "Auto-closing a click-opened root Dropdown on pointer leave",
      why: "Click-opened root menus must stay open until an action is selected, outside click, or Escape",
      instead: "Close only hover-opened submenu levels (depth >= 1) on leave",
    },
  ],
  timing: {
    openDelayMs: CASCADE_MENU_TIMINGS.OPEN_DELAY_MS,
    closeDelayMs: CASCADE_MENU_TIMINGS.CLOSE_DELAY_MS,
  },
  motion: {
    enterMs: CASCADE_MENU_TIMINGS.LEVEL_TRANSFORM_MS,
    exitMs: CASCADE_MENU_TIMINGS.LEVEL_EXIT_MS,
    transform: "8px horizontal slide",
    reducedMotion: "fade-only",
  },
  limits: {
    rootAutoCloseOnPointerLeaveAllowed: false,
    hoverOpenWithInputAllowed: false,
  },
};
