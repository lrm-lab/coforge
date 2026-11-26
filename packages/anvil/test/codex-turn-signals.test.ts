import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentRuntimeEvent } from "@lrm/coforge-anvil";
import { CodexTurnSignals } from "@lrm/coforge-anvil/codex";
import { scenarioProvider, waitForEvent } from "./codex-scenarios";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "coforge-codex-signals-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** The non-session events of one turn started with `input`, up to its `completed` event. */
async function turnEvents(
  input: string,
  options?: { allowsEmptyCompletion?: boolean },
): Promise<AgentRuntimeEvent[]> {
  const session = await scenarioProvider().createAgentSession({
    agentWorkspaceDirectory: directory,
    instructions: "Test.",
  });
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.sendMessage(input, options);
    await waitForEvent(events, "completed");
    return events.filter((event) => event.type !== "session");
  } finally {
    await session.dispose();
  }
}

const started: AgentRuntimeEvent = { type: "thinking-delta", text: "" };
const completed: AgentRuntimeEvent = { type: "completed", status: "completed" };
const failed: AgentRuntimeEvent = { type: "completed", status: "failed" };
const zeroEvidenceError: AgentRuntimeEvent = {
  type: "error",
  retryable: true,
  message:
    "Codex runtime returned an empty response. Please retry. (codex_zero_evidence_turn_completed)",
  occurredAt: expect.any(String),
  providerErrorClass: "CodexEmptyTurn",
  providerErrorReason: "zero_evidence_turn_completed",
};

test("Codex reports a completed turn with no assistant text or tool calls as retryable zero_evidence_turn_completed", async () => {
  expect(await turnEvents("empty")).toEqual([started, zeroEvidenceError, failed]);
  expect(await turnEvents("token-usage-only")).toEqual([started, zeroEvidenceError, failed]);
  expect(await turnEvents("plan-only")).toEqual([started, zeroEvidenceError, failed]);
});

test("Codex accepts an empty completion only when the input allows a silent no-op", async () => {
  expect(await turnEvents("empty", { allowsEmptyCompletion: true })).toEqual([started, completed]);
  expect(await turnEvents("token-usage-only", { allowsEmptyCompletion: true })).toEqual([
    started,
    completed,
  ]);
});

test("Codex keeps the silent no-op allowance scoped to its own turn", async () => {
  const session = await scenarioProvider().createAgentSession({
    agentWorkspaceDirectory: directory,
    instructions: "Test.",
  });
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.sendMessage("empty", { allowsEmptyCompletion: true });
    await waitForEvent(events, "completed");
    expect(events.filter((event) => event.type !== "session")).toEqual([started, completed]);
    await session.sendMessage("empty");
    for (
      let attempt = 0;
      attempt < 200 && events.filter((event) => event.type === "completed").length < 2;
      attempt += 1
    )
      await Bun.sleep(5);
    expect(events.filter((event) => event.type !== "session")).toEqual([
      started,
      completed,
      started,
      zeroEvidenceError,
      failed,
    ]);
  } finally {
    await session.dispose();
  }
});

test("Codex keeps the silent no-op allowance when only reference input steers into the turn", async () => {
  const session = await scenarioProvider().createAgentSession({
    agentWorkspaceDirectory: directory,
    instructions: "Test.",
  });
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.sendMessage("hold-empty", { allowsEmptyCompletion: true });
    await session.notify!("finish-empty", { allowsEmptyCompletion: true });
    await waitForEvent(events, "completed");
    expect(events.filter((event) => event.type !== "session")).toEqual([started, completed]);
  } finally {
    await session.dispose();
  }
});

test("Codex drops the silent no-op allowance once real input steers into the turn", async () => {
  const session = await scenarioProvider().createAgentSession({
    agentWorkspaceDirectory: directory,
    instructions: "Test.",
  });
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.sendMessage("hold-empty", { allowsEmptyCompletion: true });
    await session.notify!("finish-empty");
    await waitForEvent(events, "completed");
    expect(events.filter((event) => event.type !== "session")).toEqual([
      started,
      zeroEvidenceError,
      failed,
    ]);
  } finally {
    await session.dispose();
  }
});

test("Codex completes cleanly when a turn streams assistant text or executes a tool call", async () => {
  expect(await turnEvents("text")).toEqual([
    started,
    { type: "text-delta", text: "Done" },
    completed,
  ]);
  expect(await turnEvents("tool-only")).toEqual([
    started,
    {
      type: "tool-start",
      id: "cmd-1",
      name: "bash",
      input: { command: "true" },
      occurredAt: expect.any(String),
    },
    {
      type: "tool-end",
      id: "cmd-1",
      isError: false,
      exitCode: 0,
      durationMs: undefined,
    },
    completed,
  ]);
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
    {
      type: "activity",
      activity: {
        detailKind: "system_message",
        level: "warning",
        detail: "",
        observedAtMs: expect.any(Number),
        entries: [
          {
            kind: "system",
            title: "Codex warning",
            text: "Codex thread entered system error state without a reason",
          },
        ],
      },
    },
    error("Codex thread entered system error state"),
    { type: "text-delta", text: "Done" },
    completed,
  ]);
});

test("Codex reports diagnostics as warning Activity", async () => {
  expect(await turnEvents("diagnostics")).toEqual([
    started,
    {
      type: "activity",
      activity: {
        detailKind: "system_message",
        level: "warning",
        detail: "",
        observedAtMs: expect.any(Number),
        entries: [
          {
            kind: "system",
            title: "Codex config warning",
            text: "Bad config",
          },
        ],
      },
    },
    {
      type: "activity",
      activity: {
        detailKind: "system_message",
        level: "warning",
        detail: "",
        observedAtMs: expect.any(Number),
        entries: [
          {
            kind: "system",
            title: "Codex warning",
            text: "careful",
          },
        ],
      },
    },
    {
      type: "activity",
      activity: {
        detailKind: "system_message",
        level: "warning",
        detail: "",
        observedAtMs: expect.any(Number),
        entries: [
          {
            kind: "system",
            title: "Codex guardian warning",
            text: "guarded",
          },
        ],
      },
    },
    {
      type: "activity",
      activity: {
        detailKind: "system_message",
        level: "warning",
        detail: "",
        observedAtMs: expect.any(Number),
        entries: [
          {
            kind: "system",
            title: "Codex deprecation notice",
            text: `Old API\n${"x".repeat(400)}`,
          },
        ],
      },
    },
    {
      type: "activity",
      activity: {
        detailKind: "system_message",
        level: "warning",
        detail: "",
        observedAtMs: expect.any(Number),
        entries: [
          {
            kind: "system",
            title: "Codex warning",
            text: "Codex thread is waiting on approval\nActive flags: waitingOnApproval",
          },
        ],
      },
    },
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

const warning = (title: string, text: string): AgentRuntimeEvent => ({
  type: "activity",
  activity: {
    detailKind: "system_message",
    level: "warning",
    detail: "",
    observedAtMs: expect.any(Number),
    entries: [{ kind: "system", title, text }],
  },
});

test("Codex reports a repeated waiting status once until the wait clears", async () => {
  expect(await turnEvents("waiting-repeat")).toEqual([
    started,
    warning(
      "Codex warning",
      "Codex thread is waiting on approval\nActive flags: waitingOnApproval",
    ),
    warning(
      "Codex warning",
      "Codex thread is waiting on approval\nActive flags: waitingOnApproval",
    ),
    { type: "text-delta", text: "Done" },
    completed,
  ]);
});

test("Codex reports each diagnostic once per session", async () => {
  expect(await turnEvents("diagnostics-repeat")).toEqual([
    started,
    warning("Codex warning", "careful"),
    warning("Codex config warning", "Bad config"),
    { type: "text-delta", text: "Done" },
    completed,
  ]);
});

test("Codex reports a repeated bare system error warning once, still erroring each time", async () => {
  const bareError: AgentRuntimeEvent = {
    type: "error",
    message: "Codex thread entered system error state",
    occurredAt: expect.any(String),
    providerErrorClass: "CodexThreadSystemError",
  };
  expect(await turnEvents("system-error-bare-repeat")).toEqual([
    started,
    warning("Codex warning", "Codex thread entered system error state without a reason"),
    bareError,
    bareError,
    { type: "text-delta", text: "Done" },
    completed,
  ]);
});

const bareErrorEvent = (occurredAt: string): AgentRuntimeEvent => ({
  type: "error",
  message: "Codex thread entered system error state",
  occurredAt,
  providerErrorClass: "CodexThreadSystemError",
});

test("Codex warns again for a bare system error after the thread leaves the error state", () => {
  const signals = new CodexTurnSignals("thread-1");
  const status = (type: string, timestamp: string, activeFlags?: string[]) =>
    signals.notification(
      { method: "thread/status/changed", timestamp },
      { threadId: "thread-1", status: { type, ...(activeFlags ? { activeFlags } : {}) } },
    );
  const t = "2026-11-07T00:00:00.000Z";
  const events = [
    ...status("systemError", t)!,
    ...status("active", "2026-11-07T00:01:00.000Z", ["waitingOnApproval"])!,
    ...status("systemError", "2026-11-07T00:02:00.000Z")!,
  ];
  expect(events).toEqual([
    warning("Codex warning", "Codex thread entered system error state without a reason"),
    bareErrorEvent(t),
    warning(
      "Codex warning",
      "Codex thread is waiting on approval\nActive flags: waitingOnApproval",
    ),
    warning("Codex warning", "Codex thread entered system error state without a reason"),
    bareErrorEvent("2026-11-07T00:02:00.000Z"),
  ]);
});

test("Codex re-warns an identical diagnostic after the repeat window", () => {
  const signals = new CodexTurnSignals("thread-1");
  const diagnostic = (timestamp: string) =>
    signals.notification(
      { method: "warning", timestamp },
      { threadId: "thread-1", message: "careful" },
    );
  const t0 = "2026-11-07T00:00:00.000Z";
  const inside = "2026-11-07T00:05:00.000Z";
  const outside = "2026-11-07T00:11:00.000Z";
  expect([
    ...diagnostic(t0)!,
    ...diagnostic(inside)!,
    ...diagnostic(outside)!,
    ...diagnostic("2026-11-07T00:12:00.000Z")!,
  ]).toEqual([warning("Codex warning", "careful"), warning("Codex warning", "careful")]);
});
