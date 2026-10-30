import { describe, expect, test } from "bun:test";
import type { AgentRuntimeEvent } from "@coforge/agent";
import { kiroUpdateEvents } from "#src/kiro/update-events";
import { DshTurnEvents } from "#src/dsh/update-events";
import { CommandCodeTurnEvents } from "#src/command-code/update-events";
import { DevinTurnEvents } from "#src/devin/update-events";

const host = {
  createReplyIntentScanner: () => ({ scan: () => undefined, complete: () => {} }),
  isShellToolName: () => false,
};

/** ACP's terminal `stopped` status ends a cancelled tool call: a call left open makes the
 * daemon's stalled-recovery ledger read `hasOpenToolCall` forever and never recovers. */
describe("a stopped tool call ends across ACP adapters", () => {
  const start = { sessionUpdate: "tool_call", toolCallId: "t1", title: "Bash" };
  const stopped = { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "stopped" };

  const ends = (read: (update: Readonly<Record<string, unknown>>) => AgentRuntimeEvent[]) => {
    read(start);
    return read(stopped);
  };

  test("kiro", () => {
    expect(ends((update) => kiroUpdateEvents(update as never))).toContainEqual({
      type: "tool-end",
      id: "t1",
      isError: true,
    });
  });

  test("dsh", () => {
    const events = new DshTurnEvents(host as never);
    expect(ends((update) => events.read(update))).toContainEqual({
      type: "tool-end",
      id: "t1",
      isError: true,
    });
  });

  test("command-code", () => {
    const events = new CommandCodeTurnEvents(host as never);
    expect(ends((update) => events.read(update))).toContainEqual({
      type: "tool-end",
      id: "t1",
      isError: true,
    });
  });

  test("devin", () => {
    const events = new DevinTurnEvents(host as never);
    expect(ends((update) => events.read(update))).toContainEqual({
      type: "tool-end",
      id: "t1",
      isError: true,
    });
  });
});
