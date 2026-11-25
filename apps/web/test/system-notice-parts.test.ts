import { expect, test } from "bun:test";

import {
  systemNoticeParts,
  systemNoticeText,
  type SystemNoticeSource,
} from "#src/features/conversations/system-notice-text";

const alice = { memberId: "m1", handle: "alice", displayName: "Alice" };
const frank = {
  memberId: "m3",
  handle: "andong3",
  displayName: "Frank",
  kind: "user" as const,
};
const dax = { memberId: "m2", handle: "dax", displayName: "Dax", kind: "agent" as const };
const task = { taskId: "t1", number: 7, title: "Ship it" };

const notices: SystemNoticeSource[] = [
  { body: "", system: { kind: "task.assigned", params: { actor: alice, task, assignee: dax } } },
  {
    body: "",
    system: { kind: "channel.member_added", params: { actor: alice, members: [dax, alice] } },
  },
  {
    body: "",
    system: {
      kind: "channel.coordinator_changed",
      params: { channelId: "c1", channelName: "team", actor: alice, next: dax },
    },
  },
  { body: "Plain text from before notices had kinds.", system: undefined },
];

test("a notice split at its people reads as its text, a label without the @ before a handle (tasks #521, #591)", () => {
  for (const notice of notices) {
    const joined = systemNoticeParts(notice, "en")
      .map((part) => (typeof part === "string" ? part : part.text))
      .join("");
    expect(joined).toBe(systemNoticeText(notice, "en").replaceAll("@", ""));
  }
});

test("each person a notice names is a part of its own, with who they are", () => {
  const people = systemNoticeParts(notices[0]!, "en").filter((part) => typeof part !== "string");
  expect(people.map((part) => [part.person.handle, part.text])).toEqual([
    ["alice", "Alice"],
    ["dax", "dax"],
  ]);
});

test("a human assignee renders by display name rather than username, while an agent keeps its handle", () => {
  const assignedToHuman: SystemNoticeSource = {
    body: "",
    system: { kind: "task.assigned", params: { actor: dax, task, assignee: frank } },
  };
  expect(systemNoticeText(assignedToHuman, "zh-CN")).toContain("Frank");
  expect(systemNoticeText(assignedToHuman, "zh-CN")).not.toContain("andong3");
  const people = systemNoticeParts(assignedToHuman, "zh-CN").filter(
    (part) => typeof part !== "string",
  );
  expect(people.map((part) => [part.person.handle, part.text])).toEqual([
    ["dax", "Dax"],
    ["andong3", "Frank"],
  ]);
});
