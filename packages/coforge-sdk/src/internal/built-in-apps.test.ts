import { expect, test } from "bun:test";
import { APP_CONFIG_DEFINITIONS, BUILT_IN_APPS } from "./index";

const builtInKeys: readonly string[] = BUILT_IN_APPS.map((app) => app.key);

test("the built-in apps are Reminders and the System Cleaner", () => {
  expect(builtInKeys).toEqual(["system.reminder", "system.cleaner"]);
  for (const app of BUILT_IN_APPS) {
    expect(app.name.length).toBeGreaterThan(0);
    expect([...app.whenToUse].length).toBeLessThanOrEqual(160);
  }
});

test("every app with a config is a built-in app", () => {
  for (const appId of Object.keys(APP_CONFIG_DEFINITIONS))
    expect([appId, builtInKeys.includes(appId)]).toEqual([appId, true]);
});
