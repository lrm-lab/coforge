import { z } from "zod";

import { APP_CATEGORIES } from "./app-category";

/** The lists Settings → Applications shows, one per tab. */
export const APPS_VIEWS = ["installed", "mine", "marketplace"] as const;
export type AppsView = (typeof APPS_VIEWS)[number];

/**
 * Settings → Applications' tab and category filter, as the Settings route's search params: absent
 * for the defaults (Installed, every category), and a value no longer valid falls back to them. The
 * search text stays out of the URL, as on Members. Small, because the route's search validation
 * imports it.
 */
export const APPS_SETTINGS_SEARCH = {
  appsTab: z.enum(APPS_VIEWS).optional().catch(undefined),
  appsCategory: z.enum(APP_CATEGORIES).optional().catch(undefined),
};
