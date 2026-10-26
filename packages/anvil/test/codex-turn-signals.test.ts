import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentRuntimeEvent } from "@lrm/coforge-anvil";
import { scenarioProvider, waitForEvent } from "./codex-scenarios";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "coforge-codex-signals-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** The non-session events of one turn started with `input`, up to its `completed` event. */
async function turnEvents(input: string): Promise<AgentRuntimeEvent[]> {
  const session = await scenarioProvider().createAgentSession({
    agentWorkspaceDirectory: directory,
    instructions: "Test.",
  });
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.sendMessage(input);
    await waitForEvent(events, "completed");
    return events.filter((event) => event.type !== "session");
  } finally {
    await session.dispose();
  }
}

const started: AgentRuntimeEvent = { type: "thinking-delta", text: "" };
const completed: AgentRuntimeEvent = { type: "completed", status: "completed" };

test("Codex reports a completed turn with no evidence as an empty turn", async () => {
  expect(await turnEvents("empty")).toEqual([
    started,
    {
      type: "error",
      message:
        "Codex runtime returned an empty response. Please retry. (codex_zero_evidence_turn_completed)",
      occurredAt: expect.any(String),
      providerErrorClass: "CodexEmptyTurn",
      providerErrorReason: "empty_turn",
    },
    completed,
  ]);
});

test("Codex does not report an empty turn that streamed text or token usage", async () => {
  expect(await turnEvents("token-usage-only")).toEqual([started, completed]);
  expect(await turnEvents("text")).toEqual([
    started,
    { type: "text-delta", text: "Done" },
    completed,
  ]);
});

test("Codex does not report an empty turn whose only activity is an item with no event", async () => {
  expect(await turnEvents("plan-only")).toEqual([started, completed]);
});

test("Codex does not add an error to an interrupted empty turn", async () => {
  expect(await turnEvents("interrupted-empty")).toEqual([
    started,
    { type: "completed", status: "interrupted" },
  ]);
});

test("Codex reports a thread system error with its message or a default", async () => {
  const error = (message: string): AgentRuntimeEvent => ({
    type: "error",
    message,
    occurredAt: expect.any(String),
    providerErrorClass: "CodexThreadSystemError",
  });
  expect(await turnEvents("system-error")).toEqual([
    started,
    error("disk full"),
    { type: "text-delta", text: "Done" },
    completed,
  ]);
  expect(await turnEvents("system-error-bare")).toEqual([
    started,
    error("Codex thread entered system error state"),
    { type: "text-delta", text: "Done" },
    completed,
  ]);
});

test("Codex only logs diagnostics and waiting statuses", async () => {
  expect(await turnEvents("diagnostics")).toEqual([
    started,
    { type: "text-delta", text: "Done" },
    completed,
  ]);
});

test("Codex keeps a blank final answer as the answer, without an empty-turn error", async () => {
  expect(await turnEvents("blank-final")).toEqual([
    started,
    { type: "text-delta", text: "  \n" },
    completed,
  ]);
});
