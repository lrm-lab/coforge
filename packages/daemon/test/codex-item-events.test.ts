import { describe, expect, test } from "bun:test";
import { codexDeltaEvent, codexItemStartedEvents } from "#src/code-agent/codex/item-events";

const timestamp = "2026-10-11T11:00:00.000Z";
const started = (item: unknown) => ({
  method: "item/started",
  timestamp,
  params: { threadId: "t", turnId: "u", item },
});

describe("codexItemStartedEvents", () => {
  test("reports a command execution as a raw bash tool start", () => {
    expect(
      codexItemStartedEvents(started({ type: "commandExecution", id: "c1", command: "ls -la" })),
    ).toEqual([
      {
        type: "tool-start",
        id: "c1",
        name: "bash",
        input: { command: "ls -la" },
        occurredAt: timestamp,
      },
    ]);
    // A command without a readable command line is still a tool start.
    expect(
      codexItemStartedEvents(started({ type: "commandExecution", id: "c2" }))[0],
    ).toMatchObject({ input: { command: "command" } });
  });

  test("reports one write or edit per changed file", () => {
    expect(
      codexItemStartedEvents(
        started({
          type: "fileChange",
          id: "f1",
          changes: [
            { kind: "add", path: "/w/new.ts" },
            { kind: "update", path: "/w/old.ts" },
            { path: "/w/unknown-kind.ts" },
            { kind: "add" },
          ],
        }),
      ),
    ).toEqual([
      {
        type: "tool-start",
        id: "f1:0",
        name: "write_file",
        input: { file_path: "/w/new.ts" },
        occurredAt: timestamp,
      },
      {
        type: "tool-start",
        id: "f1:1",
        name: "edit_file",
        input: { file_path: "/w/old.ts" },
        occurredAt: timestamp,
      },
      {
        type: "tool-start",
        id: "f1:2",
        name: "edit_file",
        input: { file_path: "/w/unknown-kind.ts" },
        occurredAt: timestamp,
      },
    ]);
  });

  test("reads a file change without a change list as the one changed file", () => {
    expect(
      codexItemStartedEvents(started({ type: "fileChange", kind: "add", path: "/w/a.ts" })),
    ).toEqual([
      {
        type: "tool-start",
        id: "file-change:0",
        name: "write_file",
        input: { file_path: "/w/a.ts" },
        occurredAt: timestamp,
      },
    ]);
  });

  test("reports nothing for another item type or a command without an id", () => {
    expect(codexItemStartedEvents(started({ type: "reasoning", id: "r1" }))).toEqual([]);
    expect(codexItemStartedEvents(started({ type: "commandExecution" }))).toEqual([]);
    expect(codexItemStartedEvents(started(undefined))).toEqual([]);
  });
});

const delta = (method: string, value: unknown) => ({
  method,
  timestamp,
  params: { threadId: "t", turnId: "u", delta: value },
});

describe("codexDeltaEvent", () => {
  test("reports agent message text and reasoning summaries as deltas", () => {
    expect(codexDeltaEvent(delta("item/agentMessage/delta", "Hi"))).toEqual({
      type: "text-delta",
      text: "Hi",
    });
    expect(codexDeltaEvent(delta("item/reasoning/summaryTextDelta", "Plan"))).toEqual({
      type: "thinking-delta",
      text: "Plan",
    });
  });

  test("reports raw reasoning text only as content-free progress", () => {
    expect(codexDeltaEvent(delta("item/reasoning/textDelta", "secret chain"))).toEqual({
      type: "progress",
      source: "codex_reasoning_text_delta",
      occurredAt: timestamp,
    });
  });

  test("reports nothing for a non-string delta or another method", () => {
    expect(codexDeltaEvent(delta("item/agentMessage/delta", 1))).toBeUndefined();
    expect(codexDeltaEvent(delta("item/commandExecution/outputDelta", "out"))).toBeUndefined();
    expect(codexDeltaEvent({ method: "item/agentMessage/delta" })).toBeUndefined();
  });
});
