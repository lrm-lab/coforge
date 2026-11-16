import { createServerFn } from "@tanstack/react-start";

import { cloudDesktopUrl } from "./cloud-desktop-url";

/**
 * Site origin used for Open desktop / page-fill
 * (`COFORGE_CLOUD_DESKTOP_ORIGIN`). Null when this deployment has none.
 */
export const getCloudDesktopOrigin = createServerFn({ method: "GET" }).handler(() => {
  const configured = process.env.COFORGE_CLOUD_DESKTOP_ORIGIN?.trim() ?? "";
  if (!cloudDesktopUrl(configured, "desktop")) return null;
  return new URL(configured).origin;
});
