import { createDevicePreference } from "#src/features/settings/device-preference";

export type AppsLayout = "grid" | "list";

/** Per-device preference: Settings → Applications shows its apps as a grid (the default) or a
 * list. */
const preference = createDevicePreference<AppsLayout>({
  key: "coforge-apps-layout",
  parse: (stored) => (stored === "list" ? "list" : "grid"),
  serialize: (layout) => layout,
  fallback: "grid",
});

export const useAppsLayout = preference.useValue;
