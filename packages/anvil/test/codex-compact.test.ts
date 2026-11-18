import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeEvent } from "@lrm/coforge-anvil";
import {
  TURN_END_COMPACTION_PROGRESS_MS,
  TURN_END_COMPACTION_WAIT_MS,
  runCodexCompactRequest,
} from "../src/codex/compaction";
import type { CodexSessionState } from "../src/codex/provider-support";
import { scenarioProvider, waitForEvent } from "./codex-scenarios";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "coforge-codex-compact-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

test("Codex compact() keeps hasLiveTurn true, emits compaction + context-usage events without zero_evidence, and serializes concurrent notify()", async () => {
  const session = await scenarioProvider("slow-compact").createAgentSession({
    agentWorkspaceDirectory: directory,
    instructions: "Test compact.",
  });
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));

  try {
    await session.sendMessage("text");
    await waitForEvent(events, "completed");
    events.length = 0;

    const compactPromise = session.compact!();
    expect(session.hasLiveTurn).toBe(true);

    const notifyPromise = session.notify!("text");
    await compactPromise;
    await notifyPromise;

    for (
      let i = 0;
      i < 40 && !events.some((e) => e.type === "text-delta" && e.text === "Done");
      i++
    ) {
      await Bun.sleep(10);
    }

    expect(events.some((event) => event.type === "compaction-started")).toBe(true);
    expect(events.some((event) => event.type === "compaction-finished")).toBe(true);
    expect(
      events.some((event) => event.type === "context-usage" && event.usedTokens === 48_000),
    ).toBe(true);
    expect(events.some((event) => event.type === "error")).toBe(false);
  } finally {
    await session.dispose();
  }
});

test("runCodexCompactRequest emits progress notice and marks unconfirmed on timeout without canceling", async () => {
  expect(TURN_END_COMPACTION_PROGRESS_MS).toBe(5 * 60_000);
  expect(TURN_END_COMPACTION_WAIT_MS).toBe(10 * 60_000);
  let state: CodexSessionState = { type: "idle" };
  let progressCount = 0;
  let unconfirmedCount = 0;
  let beginIdleCount = 0;
  const methods: string[] = [];
  await runCodexCompactRequest({
    process: {
      request: async (req: { method: string }) => {
        methods.push(req.method);
        return { result: { turn: { id: "turn-slow-compact" } } };
      },
    } as never,
    threadId: "thread-1",
    getState: () => state,
    setState: (next) => {
      state = next;
    },
    beginIdle: () => {
      beginIdleCount += 1;
      state = { type: "idle" };
    },
    progressNoticeMs: 10,
    waitMs: 30,
    onProgress: () => {
      progressCount += 1;
    },
    onUnconfirmed: () => {
      unconfirmedCount += 1;
    },
  });
  expect(methods).toEqual(["thread/compact/start"]);
  expect(progressCount).toBe(1);
  expect(unconfirmedCount).toBe(1);
  expect(beginIdleCount).toBe(1);
  expect(state.type).toBe("idle");
});
