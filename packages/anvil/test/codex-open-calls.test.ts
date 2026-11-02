import { expect, test } from "bun:test";
import { asRecord, type AgentRuntimeEvent, type JsonRecord } from "@lrm/coforge-anvil";
import { CodexItemEvents } from "@lrm/coforge-anvil/codex";

// A command that never ends must stay an open call, so the daemon can report the turn stuck:
// a file change finishing beside it, announced or not and with or without an id, ends only its
// own call (Raft 1.0.59 / oar 0.76, where an id-less file change completion could close the
// pending shell call; task #339). Shapes: ThreadItem from `codex app-server generate-ts`.

const record = (method: string, item: unknown): JsonRecord => ({
  method,
  timestamp: "2026-11-02T10:00:00.000Z",
  params: { threadId: "t", turnId: "u", item },
});

function openCalls(records: readonly JsonRecord[]): Set<string> {
  const events = new CodexItemEvents();
  const open = new Set<string>();
  for (const next of records)
    for (const event of events.accept(next, asRecord(next.params)) as AgentRuntimeEvent[]) {
      if (event.type === "tool-start") open.add(event.id);
      if (event.type === "tool-end") open.delete(event.id);
    }
  return open;
}

const command = {
  type: "commandExecution",
  id: "cmd-1",
  command: "npm run dev",
  status: "inProgress",
};
const edit = (id?: string) => ({
  type: "fileChange",
  ...(id ? { id } : {}),
  status: "completed",
  changes: [{ path: "a.ts", kind: { type: "update" } }],
});

test("a running command stays open while file changes beside it finish", () => {
  expect(
    openCalls([
      record("item/started", command),
      record("item/started", edit("fc-1")),
      record("item/completed", edit("fc-1")),
      // Announced only at completion, with an id and without one.
      record("item/completed", edit("fc-2")),
      record("item/completed", edit()),
    ]),
  ).toEqual(new Set(["cmd-1"]));
});

test("the command's own completion ends it", () => {
  expect(
    openCalls([
      record("item/started", command),
      record("item/completed", { ...command, status: "completed", exitCode: 0 }),
    ]),
  ).toEqual(new Set());
});
