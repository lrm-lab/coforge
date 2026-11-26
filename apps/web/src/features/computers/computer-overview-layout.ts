import { createDevicePreference } from "#src/features/settings/device-preference";

export type ComputersOverviewLayout = "card" | "list";

const layoutPreference = createDevicePreference<ComputersOverviewLayout>({
  key: "coforge-computers-layout",
  parse: (stored) => (stored === "list" ? "list" : "card"),
  serialize: (layout) => layout,
  fallback: "card",
});

export const useComputersOverviewLayout = layoutPreference.useValue;
