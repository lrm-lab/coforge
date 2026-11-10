import { expect, test } from "bun:test";

import { applyActivityMessage } from "#src/features/inbox/activity-unread-count";
import { composeTabTitle } from "#src/lib/browser-tab";
import { unreadCountCases, VIEWER } from "./fixtures/activity-unread-cases";

/**
 * Task #62: the Activity unread count. The case table is shared with the server's count (see the
 * fixture), so the page and the database are checked against the same rules.
 */
for (const { name, before, message, viewingKey, after, reread } of unreadCountCases) {
  test(name, () => {
    const next = applyActivityMessage(before, message, {
      viewerUserId: VIEWER,
      isViewing: (key) => key === viewingKey,
    });
    expect({ state: next.state, reread: next.reread }).toEqual({ state: after, reread });
  });
}

test("a message that changes nothing hands back the state it was given", () => {
  const before = { hasUnread: true, unreadCount: 1, unreadKeys: ["conversation:channel-1"] };
  const again = { conversationId: "channel-1", sender: { kind: "user", name: "Ada" } } as const;
  expect(applyActivityMessage(before, again, { viewerUserId: VIEWER }).state).toBe(before);
});

test("only a message the dot counts lights it, whether or not it changed the state", () => {
  const held = { hasUnread: true, unreadCount: 1, unreadKeys: ["conversation:channel-1"] };
  const ada = { conversationId: "channel-1", sender: { kind: "user", name: "Ada" } } as const;
  const lights = (message: Parameters<typeof applyActivityMessage>[1], viewingKey?: string) =>
    applyActivityMessage(held, message, {
      viewerUserId: VIEWER,
      isViewing: (key) => key === viewingKey,
    }).lights;
  expect(lights(ada)).toBe(true);
  expect(lights({ ...ada, senderUserId: VIEWER })).toBe(false);
  expect(lights({ ...ada, sender: { kind: "system", name: "CoForge" } })).toBe(false);
  expect(lights({ ...ada, muted: true })).toBe(false);
  expect(lights(ada, "conversation:channel-1")).toBe(false);
});

test("the tab title carries the unread count as a prefix, 99+ at the cap", () => {
  const page = { label: "Activity", workspaceName: "Acme" };
  expect(composeTabTitle(page)).toBe("Activity | Acme | CoForge");
  expect(composeTabTitle({ ...page, unreadCount: undefined })).toBe("Activity | Acme | CoForge");
  expect(composeTabTitle({ ...page, unreadCount: 0 })).toBe("Activity | Acme | CoForge");
  expect(composeTabTitle({ ...page, unreadCount: 3 })).toBe("(3) Activity | Acme | CoForge");
  expect(composeTabTitle({ ...page, unreadCount: 99 })).toBe("(99) Activity | Acme | CoForge");
  expect(composeTabTitle({ ...page, unreadCount: 100 })).toBe("(99+) Activity | Acme | CoForge");
  expect(composeTabTitle({ unreadCount: 2 })).toBe("(2) CoForge");
});
