/**
 * Zen mode's fullscreen layer. It sits below every existing overlay layer in this codebase (Modal,
 * Tooltip, the slim sidebar nav, bubble-menu — all z-50), so a tooltip or popover opened while in
 * zen mode still renders above it, without relying on DOM/portal paint order to break the tie at an
 * equal z-index.
 */
export const ZEN_LAYER = "fixed inset-0 z-40 bg-primary safe-area-padding";
