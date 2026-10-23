import { expect, test } from "bun:test";

import {
  APP_NOTIFICATION_EVENT_NAMES,
  checkNotificationEvents,
  effectiveNotificationEvents,
  eventsAllowedBy,
  pendingNotificationEvents,
} from "#src/features/apps/app-notification-events";

test("the catalog names Raft's events, the Workspace as workspace", () => {
  expect(APP_NOTIFICATION_EVENT_NAMES).toHaveLength(20);
  expect(APP_NOTIFICATION_EVENT_NAMES.some((event) => event.startsWith("server."))).toBe(false);
  expect(checkNotificationEvents(["computer.online", "workspace.member_added"])).toEqual([
    "workspace.member_added",
    "computer.online",
  ]);
  expect(checkNotificationEvents(["server.member_added"])).toBeUndefined();
  expect(checkNotificationEvents("workspace.member_added")).toBeUndefined();
});

test("an event needs every group it names", () => {
  expect(
    eventsAllowedBy(["workspace.public_channel_created", "channel.archived"], ["channel"]),
  ).toEqual(["channel.archived"]);
  expect(eventsAllowedBy(["computer.agent_started"], ["computer"])).toEqual([]);
  expect(eventsAllowedBy(["computer.agent_started"], ["computer", "agent"])).toEqual([
    "computer.agent_started",
  ]);
});

test("effective events are subscribed, approved, and covered by approved declared groups", () => {
  const subscribed = [
    "workspace.member_added",
    "agent.profile_updated",
    "channel.archived",
  ] as const;
  expect(
    effectiveNotificationEvents({
      subscribed,
      approvedEvents: ["workspace.member_added", "agent.profile_updated"],
      declaredGroups: ["workspace", "agent", "channel"],
      approvedGroups: ["workspace", "channel"],
    }),
  ).toEqual(["workspace.member_added"]);
  // A group the app stopped declaring stops its events although the installation approved it.
  expect(
    effectiveNotificationEvents({
      subscribed,
      approvedEvents: [...subscribed],
      declaredGroups: ["agent"],
      approvedGroups: ["workspace", "agent", "channel"],
    }),
  ).toEqual(["agent.profile_updated"]);
  expect(pendingNotificationEvents(subscribed, ["channel.archived"])).toEqual([
    "workspace.member_added",
    "agent.profile_updated",
  ]);
});
