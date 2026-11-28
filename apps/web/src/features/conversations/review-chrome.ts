export const CHIP_CLASS =
  "flex h-6 min-w-0 shrink items-center gap-1 rounded-md px-1.5 text-xs text-tertiary";

export const PRESSABLE_CHIP_CLASS = `${CHIP_CLASS} cursor-pointer outline-focus-ring transition-colors duration-150 hover:bg-primary_hover hover:text-secondary focus-visible:outline-2`;

export const FLOATING_SURFACE_CLASS = "rounded-xl border border-secondary bg-primary shadow-lg";

export const TOOLBAR_BUTTON_ON_CLASS = "bg-active text-fg-secondary hover:bg-active";

export const PANEL_HEADER_CLASS =
  "flex h-pane-header shrink-0 items-center gap-1 border-b border-secondary pe-2 ps-4";

export const PANEL_TITLE_CLASS = "min-w-0 flex-1 truncate text-sm font-medium text-primary";

export const SECTION_LABEL_CLASS = "text-xs font-medium text-tertiary";

export const COMMENT_ROW_CLASS = "flex gap-3 px-3 py-3";

export const COMMENT_AUTHOR_CLASS = "truncate text-sm font-medium text-primary";

export const COMMENT_META_CLASS = "text-xs text-tertiary tabular-nums";

export const COMMENT_BODY_CLASS = "text-sm text-secondary [overflow-wrap:anywhere]";

export const COMMENT_FLASH_CLASS = "bg-tertiary";

export const COMMENT_FIELD_LAYOUT_CLASS = "relative flex flex-col gap-1";

export const COMMENT_FIELD_CLASS = `${COMMENT_FIELD_LAYOUT_CLASS} rounded-lg border border-secondary bg-primary p-2 transition-colors duration-150 focus-within:border-primary`;
