import { expect, test } from "bun:test";
import type { AgentRuntimeEvent } from "@lrm/coforge-anvil";
import { controlledClaude } from "./fixtures/claude-feed";

const compacting = { type: "system", subtype: "status", status: "compacting" };
const boundary = { type: "system", subtype: "compact_boundary" };
const overflow = {
  type: "assistant",
  error: "invalid_request",
  api_error_status: 400,
  message: { content: [{ type: "text", text: "Prompt is too long" }] },
};
const success = { type: "result", subtype: "success" };
const failure = { type: "result", subtype: "error_during_execution", is_error: true };
const singleExchange =
  "Prompt is too long · this conversation is a single exchange and cannot be compacted";

async function compactionTurn() {
  const fixture = await controlledClaude();
  const events: AgentRuntimeEvent[] = [];
  fixture.session.subscribe((event) => {
    if (
      event.type === "error" ||
      event.type === "completed" ||
      event.type === "compaction-started" ||
      event.type === "compaction-finished"
    ) {
      events.push(event);
    }
  });
  return { ...fixture, events };
}

test("Claude continues after a top-level successful compaction without reporting overflow", async () => {
  const { session, emit, dispose, events } = await compactionTurn();
  try {
    await session.sendMessage("first");
    await emit(
      compacting,
      overflow,
      { ...boundary, parent_tool_use_id: "child" },
      { ...boundary, subagent_type: "Explore" },
      { ...boundary, session_id: "another-session" },
      { ...success, session_id: "another-session", stop_reason: "refusal" },
    );
    expect(events.map(({ type }) => type)).toEqual(["compaction-started"]);
    await emit(boundary, success);
    expect(events.map(({ type }) => type)).toEqual([
      "compaction-started",
      "compaction-finished",
      "completed",
    ]);
    expect(events.at(-1)).toEqual({ type: "completed", status: "completed" });
  } finally {
    await dispose();
  }
});

test("Claude recognizes the provider's flagged overflow record even without an error code", async () => {
  const { session, emit, dispose, events } = await compactionTurn();
  try {
    await session.sendMessage("first");
    await emit(
      compacting,
      { type: "assistant", message: overflow.message, is_api_error_message: true },
      failure,
    );
    expect(events).toEqual([
      expect.objectContaining({ type: "compaction-started" }),
      expect.objectContaining({ type: "error", message: "Prompt is too long" }),
      { type: "completed", status: "failed" },
    ]);
  } finally {
    await dispose();
  }
});

test("Claude does not carry a late idle compaction status into a new turn", async () => {
  const { session, emit, dispose, events } = await compactionTurn();
  try {
    await session.sendMessage("first");
    await emit(success, compacting);
    await session.sendMessage("next");
    await emit(overflow);
    expect(events.at(-1)).toMatchObject({ type: "error", message: "Prompt is too long" });
    await emit(failure);
    expect(events.at(-1)).toEqual({ type: "completed", status: "failed" });
  } finally {
    await dispose();
  }
});

test("Claude reports a single-exchange compaction refusal as soon as it is known", async () => {
  const { session, emit, dispose, events } = await compactionTurn();
  try {
    await session.sendMessage("first");
    await emit(compacting, overflow, {
      ...overflow,
      message: { content: [{ type: "text", text: singleExchange }] },
    });
    expect(events.at(-1)).toMatchObject({ type: "error", message: singleExchange });
    await emit({ ...failure, errors: [singleExchange] });
    expect(events.filter(({ type }) => type === "error")).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: "completed", status: "failed" });
  } finally {
    await dispose();
  }
});

test("Claude emits the deferred overflow once if the compaction does not succeed", async () => {
  const { session, emit, dispose, events } = await compactionTurn();
  try {
    await session.sendMessage("first");
    await emit(compacting, overflow, overflow);
    expect(events.map(({ type }) => type)).toEqual(["compaction-started"]);
    await emit({ ...boundary, parent_tool_use_id: "child" }, failure);
    expect(events).toEqual([
      expect.objectContaining({ type: "compaction-started" }),
      expect.objectContaining({ type: "error", message: "Prompt is too long" }),
      { type: "completed", status: "failed" },
    ]);
    await session.sendMessage("next");
    await emit(overflow);
    expect(events.at(-1)).toMatchObject({ type: "error", message: "Prompt is too long" });
    await emit(failure);
    expect(events.at(-1)).toEqual({ type: "completed", status: "failed" });
  } finally {
    await dispose();
  }
});

test.each([
  ["model refusal", { ...success, stop_reason: "refusal" }, /declined/, "model_refusal"],
  [
    "concrete result error",
    { ...failure, errors: ["API Error: 529 Overloaded"] },
    /529/,
    undefined,
  ],
  [
    "compaction failure with an underlying reason",
    {
      ...failure,
      errors: ["Prompt is too long · automatic compaction failed: authentication failed"],
    },
    /authentication failed/,
    undefined,
  ],
  ["concrete HTTP status", { ...failure, api_error_status: 401 }, /401/, undefined],
  [
    "single-exchange failure",
    { ...failure, errors: [singleExchange] },
    /single exchange/,
    undefined,
  ],
] as const)(
  "Claude prefers a %s over the deferred overflow",
  async (_label, result, reason, code) => {
    const { session, emit, dispose, events } = await compactionTurn();
    try {
      await session.sendMessage("first");
      await emit(compacting, overflow, result);
      expect(events).toEqual([
        expect.objectContaining({ type: "compaction-started" }),
        expect.objectContaining({ type: "error", message: expect.stringMatching(reason) }),
        { type: "completed", status: "failed" },
      ]);
      expect(events[1]).toMatchObject(code ? { providerErrorReason: code } : { type: "error" });
    } finally {
      await dispose();
    }
  },
);

test("Claude retains the deferred overflow when the provider exits before the boundary", async () => {
  const { session, emit, dispose, events } = await compactionTurn();
  try {
    await session.sendMessage("first");
    await emit(compacting, overflow);
    const exited = new Promise<void>((resolve) => session.onExit(() => resolve()));
    if (!session.processId) throw new Error("Missing fixture process");
    process.kill(session.processId, "SIGTERM");
    await exited;
    expect(events).toEqual([
      expect.objectContaining({ type: "compaction-started" }),
      expect.objectContaining({ type: "error", message: "Prompt is too long" }),
    ]);
  } finally {
    await dispose();
  }
});
