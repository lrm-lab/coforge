import { expect, test } from "bun:test";
import { backTargetOf, sectionOf, tabHomeOf } from "#src/components/layout/tab-home";

/** Task #77: which phone tab home a page is, and where an inner page's back button goes. */
test("a path's section is its first segment under the Workspace", () => {
  expect(sectionOf("/w/acme")).toBe("");
  expect(sectionOf("/w/acme/dm/0b5c")).toBe("dm");
  expect(sectionOf("/w/acme/agent/7f1e/chat")).toBe("agent");
  expect(sectionOf("/login")).toBe("");
});

test("the tab bar shows on a tab home only", () => {
  const home = (section: string, more: { itemOpen?: boolean; chatListOpen?: boolean } = {}) =>
    tabHomeOf({ section, itemOpen: false, chatListOpen: false, ...more });
  expect(home("")).toBe("chat");
  // A conversation is an inner page until its back arrow brings Chat's list over it.
  for (const section of ["channel", "dm", "saved", "drafts"]) {
    expect(home(section)).toBeNull();
    expect(home(section, { chatListOpen: true })).toBe("chat");
  }
  expect(home("activity")).toBe("activity");
  expect(home("activity", { itemOpen: true })).toBeNull();
  expect(home("workspace")).toBe("workspace");
  expect(home("me")).toBe("me");
  expect(home("projects")).toBeNull();
  expect(home("settings")).toBeNull();
});

test("an inner page goes back to the tab it belongs to", () => {
  for (const section of [
    "projects",
    "tasks",
    "members",
    "agent",
    "records",
    "computers",
    "computer",
  ])
    expect(backTargetOf(section)).toBe("workspace");
  expect(backTargetOf("settings")).toBe("me");
  expect(backTargetOf("channel")).toBe("history");
});
