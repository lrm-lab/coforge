import { expect, test } from "bun:test";

import {
  systemNoticeParts,
  systemNoticeText,
  type SystemNoticeSource,
} from "#src/features/conversations/system-notice-text";

const alice = { memberId: "m1", handle: "alice", displayName: "Alice" };
const dax = { memberId: "m2", handle: "dax", displayName: "Dax", kind: "agent" as const };
const task = { taskId: "t1", number: 7, title: "Ship it" };

const notices: SystemNoticeSource[] = [
  { body: "", system: { kind: "task.assigned", params: { actor: alice, task, assignee: dax } } },
  {
    body: "",
    system: { kind: "channel.member_added", params: { actor: alice, members: [dax, alice] } },
  },
  { body: "Plain text from before notices had kinds.", system: undefined },
];

test("a notice split at its people reads word for word as its text (task #521)", () => {
  for (const notice of notices) {
    const joined = systemNoticeParts(notice, "en")
      .map((part) => (typeof part === "string" ? part : part.text))
      .join("");
    expect(joined).toBe(systemNoticeText(notice, "en"));
  }
});

test("each person a notice names is a part of its own, with who they are", () => {
  const people = systemNoticeParts(notices[0]!, "en").filter((part) => typeof part !== "string");
  expect(people.map((part) => [part.person.handle, part.text])).toEqual([
    ["alice", "Alice"],
    ["dax", "@dax"],
  ]);
});
