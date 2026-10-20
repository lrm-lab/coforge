import { expect, test } from "bun:test";
import { BUILT_IN_APPS } from "@lrm/coforge-sdk/internal";
import {
  AGENT_APP_REGISTRY,
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

test("every app with App Inbox items is a built-in app", () => {
  const builtInKeys: readonly string[] = BUILT_IN_APPS.map((app) => app.key);
  for (const appId of Object.keys(AGENT_APP_REGISTRY))
    expect([appId, builtInKeys.includes(appId)]).toEqual([appId, true]);
});
