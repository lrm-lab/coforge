/**
 * The one layer every overlay that covers the screen sits on: the official modal's `z-50`. React
 * Aria portals each overlay to the end of `<body>` as it opens, so among overlays on one layer the
 * one opened last is on top, whichever kind each is (task #519: a profile slideout opened from a
 * Task popup had no layer and showed under it). Popovers and tooltips are React Aria's to place,
 * above all of these (`useOverlayPosition`'s inline `z-index: 100000`).
 */
export const OVERLAY_LAYER = "z-50";
