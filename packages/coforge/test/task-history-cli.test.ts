import { expect, test } from "bun:test";
import { run } from "../index";
import { taskStamps } from "./task-stamps";

test("Task history lists current and superseded card state", async () => {
  const base = {
    check: async () => ({ messages: [] }),
    read: async () => undefined,
    send: async () => undefined,
    view: async () => ({ bytes: new Uint8Array() }),
  };
  const task = {
    messageId: "message",
    conversationId: "conversation",
    number: 2,
    title: "Ship it",
    status: "in_progress" as const,
    revision: 3,
    ...taskStamps,
    owner: null,
  };
  const args = ["task", "history", "--target", "#general", "--number", "2"];
  expect(
    await run(args, {
      ...base,
      task: async () => ({
        tasks: [task],
        history: [
          {
            id: "event",
            seq: 3,
            eventType: "status_changed",
            actorType: "agent",
            actorName: "builder",
            createdAt: "2026-09-23T06:00:00.000Z",
            payload: { from: "todo", to: "in_progress" },
          },
          {
            id: "system-event",
            seq: 4,
            eventType: "assignee_changed",
            actorType: "system",
            actorName: null,
            createdAt: "2026-09-23T06:01:00.000Z",
            payload: { assigneeId: null, assigneeType: null },
          },
          {
            id: "legacy-event",
            seq: 5,
            eventType: "amended",
            actorType: "user",
            actorName: null,
            createdAt: "2026-09-23T06:02:00.000Z",
            payload: {
              changes: {
                title: { from: "Ship", to: "Ship it" },
                description: { from: null, to: "See the log" },
              },
            },
          },
        ],
      }),
    }),
  ).toBe(
    "## Task #2 history — revision 3\n\nCurrent title: Ship it\nCurrent description: (none set)\n\n" +
      'seq=3 time=2026-09-23T06:00:00.000Z actor=@builder type=status_changed\n  {"from":"todo","to":"in_progress"}\n' +
      'seq=4 time=2026-09-23T06:01:00.000Z actor=@system type=assignee_changed\n  {"assigneeId":null,"assigneeType":null}\n' +
      'seq=5 time=2026-09-23T06:02:00.000Z actor=<unresolved> type=amended\n  {"changes":{"title":{"from":"Ship","to":"Ship it"},"description":{"from":null,"to":"See the log"}}}\n' +
      "  Superseded card:\n    title: Ship\n    description: (none set)",
  );
  expect(await run(args, { ...base, task: async () => ({ tasks: [task], history: [] }) })).toBe(
    "## Task #2 history — revision 3\n\nCurrent title: Ship it\nCurrent description: (none set)\n\nNo recorded events.",
  );
});
