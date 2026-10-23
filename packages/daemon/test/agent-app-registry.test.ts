import { expect, test } from "bun:test";
import { BUILT_IN_APPS } from "@lrm/coforge-sdk/internal";
import {
  AGENT_APP_REGISTRY,
  SYSTEM_NOTICE_SOURCES,
  appInboxDefinition,
  reminderDueItemId,
} from "#src/agent-app-inbox/registry";

test("a reminder ack names the same App Inbox item its due notice was stored as", () => {
  const reminderId = "2e7b76b0-560d-4870-80a7-02312788247a";
  const stored = appInboxDefinition("system.reminder", "due").itemId({
    kind: "reminder",
    id: reminderId,
    revision: "13",
  });
  // An ack carries the revision as a number; the item was keyed by its string form.
  expect(reminderDueItemId(reminderId, 13)).toBe(stored);
  expect(stored).toBe(`reminder:${reminderId}:13`);
});

test("a system notice source is never mistaken for a built-in app", () => {
  const builtInKeys: readonly string[] = BUILT_IN_APPS.map((app) => app.key);
  for (const source of Object.keys(SYSTEM_NOTICE_SOURCES)) {
    expect([source, builtInKeys.includes(source)]).toEqual([source, false]);
    expect(source in AGENT_APP_REGISTRY).toBe(false);
  }
  // Both kinds of source resolve to a definition.
  expect(appInboxDefinition("system.app_registry", "client_secret").retention).toBe("transient");
});

test("every app with App Inbox items is a built-in app", () => {
  const builtInKeys: readonly string[] = BUILT_IN_APPS.map((app) => app.key);
  for (const appId of Object.keys(AGENT_APP_REGISTRY))
    expect([appId, builtInKeys.includes(appId)]).toEqual([appId, true]);
});
