import { describe, expect, test } from "bun:test";

import {
  groupSystemMessages,
  summarizeSystemGroup,
  systemMessageKind,
} from "./system-message-groups";

type Row = {
  id: string;
  senderKind: "user" | "agent" | "system";
  body: string;
  system?: { kind: string; params: unknown };
};

const system = (id: string, body = `notice ${id}`): Row => ({ id, senderKind: "system", body });
const user = (id: string): Row => ({ id, senderKind: "user", body: `hello ${id}` });
const notice = (id: string, kind: string): Row => ({
  id,
  senderKind: "system",
  body: `notice ${id}`,
  system: { kind, params: {} },
});

describe("system message kind", () => {
  test("every task notice is a task update, assignments included", () => {
    for (const kind of [
      "task.created",
      "task.converted",
      "task.from_message",
      "task.assigned",
      "task.claimed",
      "task.moved",
      "task.unassigned",
      "task.unfollowed",
      "task.assigned_you",
    ])
      expect(systemMessageKind(notice("a", kind))).toBe("taskUpdate");
  });

  test("anything else is a plain system message, whatever its text says", () => {
    expect(systemMessageKind(notice("a", "channel.coordinator_changed"))).toBe("system");
    expect(systemMessageKind(notice("a", "agent_dm.chain_limit"))).toBe("system");
    expect(systemMessageKind(notice("a", "legacy_text"))).toBe("system");
    expect(systemMessageKind(system("a", '📌 frank-an claimed #4 "Fix login"'))).toBe("system");
  });
});

describe("grouping system messages", () => {
  test("a run of two or more consecutive system messages becomes one group", () => {
    const items = groupSystemMessages([user("u1"), system("a"), system("b"), system("c")]);

    expect(items).toEqual([
      { type: "message", message: user("u1") },
      {
        type: "systemGroup",
        id: "system-group:a:c",
        messages: [system("a"), system("b"), system("c")],
      },
    ]);
  });

  test("a single system message stays a message", () => {
    const items = groupSystemMessages([system("a"), user("u1"), system("b")]);

    expect(items.map((item) => item.type)).toEqual(["message", "message", "message"]);
  });

  test("a non-system message ends the run", () => {
    const items = groupSystemMessages([
      system("a"),
      system("b"),
      user("u1"),
      system("c"),
      system("d"),
    ]);

    expect(items.map((item) => (item.type === "systemGroup" ? item.id : item.message.id))).toEqual([
      "system-group:a:b",
      "u1",
      "system-group:c:d",
    ]);
  });

  test("a break the caller asks for splits a run, and a lone leftover stays a message", () => {
    const items = groupSystemMessages(
      [system("a"), system("b"), system("c")],
      (message) => message.id === "c",
    );

    expect(items.map((item) => (item.type === "systemGroup" ? item.id : item.message.id))).toEqual([
      "system-group:a:b",
      "c",
    ]);
  });
});

describe("summarizing a group", () => {
  test("counts each kind and lists task updates before other system messages", () => {
    const summary = summarizeSystemGroup([
      system("a", "Frank An joined the channel."),
      notice("b", "task.claimed"),
      notice("c", "task.moved"),
    ]);

    expect(summary).toEqual({
      total: 3,
      parts: [
        { kind: "taskUpdate", count: 2 },
        { kind: "system", count: 1 },
      ],
    });
  });

  test("leaves out the kinds a group does not contain", () => {
    const summary = summarizeSystemGroup([
      notice("a", "task.claimed"),
      notice("b", "task.assigned"),
    ]);

    expect(summary).toEqual({ total: 2, parts: [{ kind: "taskUpdate", count: 2 }] });
  });
});
