import { afterEach, expect, jest, test } from "bun:test";
import { lstat, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeEvent } from "@coforge/agent";
import { readClaudeSessionResumeFacts } from "@lrm/coforge-anvil/claude-code";
import { readCodexSessionResumeFacts } from "@lrm/coforge-anvil/codex";
import { ActivityTrajectory } from "#src/agent-runtime/activity-trajectory";
import { ToolCallLedger } from "#src/agent-runtime/tool-call-ledger";
import {
  selectColdIdleStops,
  type ColdIdleSweepView,
} from "#src/agent-runtime/wake-session-recycle";
import { claudeHistoryHost } from "#src/code-agent/claude-code/history-host";
import { codexHistoryHost } from "#src/code-agent/codex/history-host";
import { StalledTurnTracker } from "#src/daemon-runtime/stalled-turn-indicator";
import { PosixProcessOwner } from "#src/platform/posix-process-tree";
import { assistantRecord, claudeConfigFixture } from "./claude-transcript-fixtures";

const tempRoots: string[] = [];

afterEach(async () => {
  jest.useRealTimers();
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("StalledTurnTracker reuses its timer on forward progress and shortens immediately on model-to-tool switch", () => {
  jest.useFakeTimers();
  jest.setSystemTime(1_000);
  const origSetTimeout = globalThis.setTimeout;
  const origClearTimeout = globalThis.clearTimeout;
  let sets = 0;
  let clears = 0;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    sets += 1;
    return origSetTimeout(...args);
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((...args: Parameters<typeof clearTimeout>) => {
    clears += 1;
    return origClearTimeout(...args);
  }) as typeof clearTimeout;

  try {
    const fired: Array<{ silentForMs: number; window: string }> = [];
    const tracker = new StalledTurnTracker(
      (_id, indicator) =>
        fired.push({ silentForMs: indicator.silentForMs, window: indicator.window }),
      1_000,
      Date.now,
      5_000,
    );
    tracker.start("a", { turnBusy: true, lastEventAtMs: 1_000, hasOpenToolCall: false });
    expect(sets).toBe(1);
    for (let i = 1; i <= 50; i += 1) {
      jest.advanceTimersByTime(10);
      tracker.observe("a", {
        turnBusy: true,
        lastEventAtMs: 1_000 + i * 10,
        hasOpenToolCall: false,
      });
    }
    expect(sets).toBe(1);
    expect(clears).toBe(0);

    tracker.observe("a", { turnBusy: true, lastEventAtMs: 1_500, hasOpenToolCall: true });
    expect(sets).toBe(2);
    expect(clears).toBe(1);

    jest.advanceTimersByTime(999);
    expect(fired).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(fired).toEqual([{ silentForMs: 1_000, window: "tool" }]);
    tracker.finish("a");
  } finally {
    globalThis.setTimeout = origSetTimeout;
    globalThis.clearTimeout = origClearTimeout;
  }
});

test("ActivityTrajectory arms one timer across a streaming burst and flushes at the moved quiet deadline", () => {
  jest.useFakeTimers();
  jest.setSystemTime(10_000);
  const origSetTimeout = globalThis.setTimeout;
  let sets = 0;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    sets += 1;
    return origSetTimeout(...args);
  }) as typeof setTimeout;

  try {
    const events: AgentRuntimeEvent[] = [];
    const trajectory = new ActivityTrajectory((event) => events.push(event));
    trajectory.accept({ type: "text-delta", text: "a" });
    for (let i = 0; i < 30; i += 1) {
      jest.advanceTimersByTime(10);
      trajectory.accept({ type: "text-delta", text: "b" });
    }
    expect(sets).toBe(1);
    jest.advanceTimersByTime(349);
    expect(events).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      activity: { entries: [{ kind: "text", text: "a" + "b".repeat(30) }] },
    });
    trajectory.dispose();
  } finally {
    globalThis.setTimeout = origSetTimeout;
  }
});

test("ToolCallLedger keeps oldest open tool accurate across interleaved ends, restarts, and finish", () => {
  let now = 100;
  const ledger = new ToolCallLedger(
    () => now,
    () => now * 10,
    () => now * 100,
  );
  ledger.observe({ type: "tool-start", id: "c1", name: "first" });
  now = 200;
  ledger.observe({ type: "tool-start", id: "c2", name: "second" });
  now = 300;
  ledger.observe({ type: "tool-start", id: "c3", name: "third" });
  expect(ledger.hasOpenToolCall).toBe(true);
  expect(ledger.oldestOpenToolStartedAtMs()).toBe(1_000);

  now = 400;
  ledger.observe({ type: "tool-start", id: "c1", name: "first-restarted" });
  expect(ledger.oldestOpenTool()?.name).toBe("second");
  expect(ledger.oldestOpenToolStartedAtMs()).toBe(2_000);

  ledger.finish({ type: "tool-end", id: "c2", isError: false });
  expect(ledger.oldestOpenTool()?.name).toBe("third");
  expect(ledger.oldestOpenToolStartedProcessClockMs()).toBe(30_000);

  ledger.observe({ type: "tool-end", id: "c3", isError: false });
  expect(ledger.oldestOpenTool()?.name).toBe("first-restarted");

  ledger.logAbandoned();
  expect(ledger.hasOpenToolCall).toBe(false);
  expect(ledger.oldestOpenTool()).toBeUndefined();
});

test("readClaudeSessionResumeFacts caches unchanged transcripts by stat and invalidates on edits, symlinks, or sidecar updates", async () => {
  const claude = await claudeConfigFixture();
  tempRoots.push(claude.configDir);
  const path = await claude.transcript("sess-cache", [
    assistantRecord({
      timestamp: "2026-10-23T01:00:00.000Z",
      usage: { input: 10, cacheRead: 100_000, cacheCreate: 0 },
    }),
  ]);

  let dirReads = 0;
  let tailReads = 0;
  const host = {
    ...claudeHistoryHost,
    readDirectoryEntries: async (dir: string) => {
      dirReads += 1;
      return claudeHistoryHost.readDirectoryEntries(dir);
    },
    readFileTail: async (file: string, bytes: number) => {
      tailReads += 1;
      return claudeHistoryHost.readFileTail(file, bytes);
    },
  };

  const first = await readClaudeSessionResumeFacts(
    { sessionId: "sess-cache", envVars: claude.envVars },
    host,
  );
  expect(first).toEqual({
    lastActivityAtMs: Date.parse("2026-10-23T01:00:00.000Z"),
    lastContextTokens: 100_010,
  });
  expect(dirReads).toBe(1);
  expect(tailReads).toBe(1);

  const second = await readClaudeSessionResumeFacts(
    { sessionId: "sess-cache", envVars: claude.envVars },
    host,
  );
  expect(second).toEqual(first);
  expect(dirReads).toBe(1);
  expect(tailReads).toBe(1);

  const sidecarRoot = path.replace(/\.jsonl$/, "");
  const sidecarDir = join(sidecarRoot, "tool-results");
  await mkdir(sidecarDir, { recursive: true });
  const sidecarTime = new Date("2026-10-23T04:00:00.000Z");
  await utimes(sidecarDir, sidecarTime, sidecarTime);
  const old = new Date("2020-01-01T00:00:00.000Z");
  await utimes(sidecarRoot, old, old);
  const third = await readClaudeSessionResumeFacts(
    { sessionId: "sess-cache", envVars: claude.envVars },
    host,
  );
  expect(third?.lastActivityAtMs).toBe(sidecarTime.getTime());
  expect(tailReads).toBe(1);

  await writeFile(
    path,
    `${assistantRecord({
      timestamp: "2026-10-23T05:00:00.000Z",
      usage: { input: 20, cacheRead: 200_000, cacheCreate: 0 },
    })}\n`,
  );
  const fourth = await readClaudeSessionResumeFacts(
    { sessionId: "sess-cache", envVars: claude.envVars },
    host,
  );
  expect(fourth).toEqual({
    lastActivityAtMs: Date.parse("2026-10-23T05:00:00.000Z"),
    lastContextTokens: 200_020,
  });
  expect(dirReads).toBe(1);
  expect(tailReads).toBe(2);

  const target = join(claude.configDir, "real-outside.jsonl");
  await writeFile(target, "{}\n");
  await rm(path);
  await symlink(target, path);
  expect(
    await readClaudeSessionResumeFacts({ sessionId: "sess-cache", envVars: claude.envVars }, host),
  ).toBeUndefined();
});

test("readCodexSessionResumeFacts caches unchanged rollouts by path stat and discovers newer rotated rollouts", async () => {
  const root = join(tmpdir(), `coforge-codex-cache-${crypto.randomUUID()}`);
  tempRoots.push(root);
  const sessionDir = join(root, "sessions", "2026", "10", "23");
  await mkdir(sessionDir, { recursive: true });
  const filePath = join(sessionDir, "rollout-2026-10-23T01-00-00-thread-cache-1.jsonl");
  await writeFile(
    filePath,
    `${JSON.stringify({
      timestamp: "2026-10-23T01:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: { input_tokens: 100, total_tokens: 90_000 } },
      },
    })}\n`,
  );

  let tailReads = 0;
  let boundStatCalls = 0;
  const host = {
    ...codexHistoryHost,
    statTag: "bound-host",
    async lstat(this: { statTag: string }, target: string) {
      if (this.statTag !== "bound-host") throw new Error("lost this binding");
      boundStatCalls += 1;
      return lstat(target);
    },
    readFileTail: async (file: string, bytes: number) => {
      tailReads += 1;
      return codexHistoryHost.readFileTail(file, bytes);
    },
  };
  const envVars = { CODEX_HOME: root };

  const first = await readCodexSessionResumeFacts({ sessionId: "thread-cache-1", envVars }, host);
  expect(first).toEqual({
    lastActivityAtMs: Date.parse("2026-10-23T01:00:00.000Z"),
    lastContextTokens: 90_000,
  });
  expect(tailReads).toBe(1);
  expect(boundStatCalls).toBe(1);

  const second = await readCodexSessionResumeFacts({ sessionId: "thread-cache-1", envVars }, host);
  expect(second).toEqual(first);
  expect(second).not.toBe(first);
  expect(tailReads).toBe(1);
  expect(boundStatCalls).toBe(2);

  await writeFile(
    filePath,
    `${JSON.stringify({
      timestamp: "2026-10-23T02:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: { input_tokens: 100, total_tokens: 180_000 } },
      },
    })}\n`,
  );
  const third = await readCodexSessionResumeFacts({ sessionId: "thread-cache-1", envVars }, host);
  expect(third).toEqual({
    lastActivityAtMs: Date.parse("2026-10-23T02:00:00.000Z"),
    lastContextTokens: 180_000,
  });
  expect(tailReads).toBe(2);

  const newerDir = join(root, "sessions", "2026", "10", "24");
  await mkdir(newerDir, { recursive: true });
  await writeFile(
    join(newerDir, "rollout-2026-10-24T01-00-00-thread-cache-1.jsonl"),
    `${JSON.stringify({
      timestamp: "2026-10-24T01:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: { input_tokens: 100, total_tokens: 240_000 } },
      },
    })}\n`,
  );
  const fourth = await readCodexSessionResumeFacts({ sessionId: "thread-cache-1", envVars }, host);
  expect(fourth).toEqual({
    lastActivityAtMs: Date.parse("2026-10-24T01:00:00.000Z"),
    lastContextTokens: 240_000,
  });
  expect(tailReads).toBe(3);
});

test("selectColdIdleStops overlaps readFacts with bounded concurrency while keeping stop order", async () => {
  const nowMs = Date.parse("2026-10-23T12:00:00.000Z");
  const views: ColdIdleSweepView[] = Array.from({ length: 8 }, (_, index) => ({
    agentId: `agent-${index}`,
    provider: "claude-code",
    busyReason: undefined,
    supported: true,
    sessionId: `sess-${index}`,
    lastEventAtMs: nowMs - 80 * 60_000,
  }));
  let inFlight = 0;
  let maxInFlight = 0;
  const stops = await selectColdIdleStops(views, {
    nowMs,
    readFacts: async (view) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Bun.sleep(20);
      inFlight -= 1;
      const idx = Number(view.agentId.split("-")[1]);
      return {
        lastActivityAtMs: nowMs - 70 * 60_000,
        lastContextTokens: idx % 2 === 0 ? 200_000 : 10_000,
      };
    },
  });
  expect(maxInFlight).toBeGreaterThan(1);
  expect(maxInFlight).toBeLessThanOrEqual(4);
  expect(stops.map((stop) => stop.agentId)).toEqual(["agent-0", "agent-2", "agent-4", "agent-6"]);
});

test("PosixProcessOwner waitForExit detects live orphaned group members even after leader exits", async () => {
  if (process.platform === "win32") return;
  const owner = new PosixProcessOwner(process.platform);
  const tree = owner.spawn(["sh", "-c", "sleep 30 & exit 0"], tmpdir(), {
    PATH: "/usr/bin:/bin",
  });
  try {
    expect(await tree.child.exited).toBe(0);
    expect(await tree.waitForExit(80)).toBe(false);
  } finally {
    await tree.terminate(true);
    expect(await tree.waitForExit(2_000)).toBe(true);
  }
});
