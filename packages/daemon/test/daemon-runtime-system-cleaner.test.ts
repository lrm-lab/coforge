import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeConfig, AgentRuntimeEvent } from "@lrm/coforge-anvil";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { DaemonRuntime, type WorkspaceConfig } from "#src/daemon-runtime/runtime";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";
import { sessionSpy } from "./fixtures/session-spy";

// The System Cleaner tests own their runtime, clock and measurements, so they live apart from the
// runtime suite's shared fixtures.
const tempRoot = realpathSync(tmpdir());
const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot: join(tempRoot, `coforge-daemon-runtime-cleaner-${crypto.randomUUID()}`),
};
const config: AgentRuntimeConfig = {
  provider: "pi",
  model: "default",
  modelProvider: "anthropic",
  reasoning: "balanced",
};

describe("DaemonRuntime System Cleaner", () => {
  test("presents a due System Cleaner hint at turn end and never starts a stopped Agent for it", async () => {
    const stateDirectory = join(tempRoot, `coforge-cleaner-runtime-${crypto.randomUUID()}`);
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const notices: string[] = [];
    let listener: ((event: AgentRuntimeEvent) => void) | undefined;
    const exits = new Set<() => void>();
    let starts = 0;
    const timers = new Map<number, { atMs: number; run: () => void }>();
    let nowMs = 0;
    let nextTimer = 1;
    const clock = {
      now: () => nowMs,
      schedule: (run: () => void, delayMs: number) => {
        timers.set(nextTimer, { atMs: nowMs + delayMs, run });
        return nextTimer++;
      },
      cancel: (handle: unknown) => {
        timers.delete(handle as number);
      },
    };
    const advance = (ms: number) => {
      nowMs += ms;
      for (const [id, timer] of timers)
        if (timer.atMs <= nowMs) {
          timers.delete(id);
          timer.run();
        }
    };
    const measuredPaths: string[] = [];
    let deleteWorkspace:
      | ((
          request: import("@lrm/coforge-sdk/internal").AgentWorkspaceDeleteRequest,
        ) => Promise<void>)
      | undefined;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        createAgentSession: async () => {
          starts++;
          return {
            ...sessionSpy(),
            notify: async (notice) => {
              notices.push(notice);
            },
            subscribe(next) {
              listener = next;
              return () => {
                listener = undefined;
              };
            },
            onExit(next) {
              exits.add(next);
              return () => exits.delete(next);
            },
          };
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          async requestAgentApiKey() {
            return `sk_agent_${"a".repeat(43)}`;
          },
          async revokeAgentApiKey() {},
          onWorkspaceDelete(handler) {
            deleteWorkspace = handler;
            return () => {};
          },
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
      stateDirectory,
      {},
      undefined,
      {
        clock,
        measureMemoryFile: async (path) => {
          measuredPaths.push(path);
          // MEMORY.md is over its limit; the Active Context is small and stays quiet.
          return {
            kind: "measured",
            bytes: path.endsWith("notes/active-context.md") ? 1024 : 70 * 1024,
          };
        },
        measureDiskSpace: async () => ({
          kind: "measured",
          availableBytes: 200 * 1024 ** 3,
          totalBytes: 500 * 1024 ** 3,
        }),
      },
    );
    const cleanerConfig = (revision: number) => ({
      appId: "system.cleaner",
      ownerAgentId: "agent-a",
      enabled: true,
      thresholdBytes: 64 * 1024,
      activeContextThresholdBytes: 4 * 1024,
      intervalMs: 3_600_000,
      revision,
    });
    try {
      await runtime.start(connection);
      await runtime.startAgent("agent-a", config);
      expect(runtime.systemCleaner.applyConfig(cleanerConfig(1))).toEqual({
        kind: "applied",
        activeSchedules: 1,
      });
      advance(3_600_000);
      await runtime.systemCleaner.settled();
      expect(measuredPaths).toEqual([
        join(connection.workspaceRoot, connection.workspaceId, "agents", "agent-a", "MEMORY.md"),
        join(
          connection.workspaceRoot,
          connection.workspaceId,
          "agents",
          "agent-a",
          "notes",
          "active-context.md",
        ),
      ]);
      // Measured, but presented only when a turn ends.
      expect(notices).toEqual([]);

      listener?.({ type: "completed", status: "completed" });
      await runtime.systemCleaner.settled();
      expect(notices).toEqual(["New app item available. Run coforge inbox check."]);
      const context = runtime.issueAgentContext("agent-a");
      const snapshot = await runtime.inbox(context, {
        idempotencyKey: "check",
        context,
        operation: "check",
      });
      expect(
        snapshot.entries.map((entry) =>
          entry.kind === "app" ? [entry.app.itemId, entry.app.retention] : entry.kind,
        ),
      ).toEqual([
        ["cleaner:disk_space:agent-a", "transient"],
        ["cleaner:memory_size:agent-a", "transient"],
      ]);

      // A hint due when the Agent's process ends cleanly is kept for its next launch, but does
      // not start it.
      runtime.systemCleaner.applyConfig(cleanerConfig(2));
      advance(3_600_000);
      await runtime.systemCleaner.settled();
      for (const exit of exits) exit();
      await runtime.systemCleaner.settled();
      // Two periods of both files, then a remeasure of MEMORY.md at the turn end and another at
      // the exit: the Active Context was never due, so it is never remeasured.
      expect(measuredPaths).toHaveLength(6);
      expect(starts).toBe(1);
      expect(notices).toHaveLength(1);

      // Deleting the Agent's workspace here forgets its cleaner: any revision applies afresh.
      expect(runtime.systemCleaner.applyConfig(cleanerConfig(1))).toEqual({
        kind: "stale",
        currentRevision: 2,
      });
      await deleteWorkspace?.({
        protocolMajor: 1,
        requestId: "delete-1",
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        agentId: "agent-a",
      });
      expect(runtime.systemCleaner.applyConfig(cleanerConfig(1))).toEqual({
        kind: "applied",
        activeSchedules: 1,
      });
    } finally {
      await runtime.stop();
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  test("presents a System Cleaner hint that falls due during a background-task wait at its final Idle", async () => {
    const stateDirectory = join(tempRoot, `coforge-cleaner-wait-${crypto.randomUUID()}`);
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const notices: string[] = [];
    let listener: ((event: AgentRuntimeEvent) => void) | undefined;
    let liveTurn = true;
    const timers = new Map<number, { atMs: number; run: () => void }>();
    let nowMs = 0;
    let nextTimer = 1;
    const clock = {
      now: () => nowMs,
      schedule: (run: () => void, delayMs: number) => {
        timers.set(nextTimer, { atMs: nowMs + delayMs, run });
        return nextTimer++;
      },
      cancel: (handle: unknown) => {
        timers.delete(handle as number);
      },
    };
    const advance = (ms: number) => {
      nowMs += ms;
      for (const [id, timer] of timers)
        if (timer.atMs <= nowMs) {
          timers.delete(id);
          timer.run();
        }
    };
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        createAgentSession: async () => ({
          ...sessionSpy(),
          get hasLiveTurn() {
            return liveTurn;
          },
          notify: async (notice) => {
            notices.push(notice);
          },
          subscribe(next) {
            listener = next;
            return () => {
              listener = undefined;
            };
          },
        }),
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          async requestAgentApiKey() {
            return `sk_agent_${"a".repeat(43)}`;
          },
          async revokeAgentApiKey() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
      stateDirectory,
      {},
      undefined,
      {
        clock,
        measureMemoryFile: async () => ({ kind: "measured", bytes: 70 * 1024 }),
        measureDiskSpace: async () => ({
          kind: "measured",
          availableBytes: 200 * 1024 ** 3,
          totalBytes: 500 * 1024 ** 3,
        }),
      },
    );
    try {
      await runtime.start(connection);
      await runtime.startAgent("agent-a", config);
      runtime.systemCleaner.applyConfig({
        appId: "system.cleaner",
        ownerAgentId: "agent-a",
        enabled: true,
        thresholdBytes: 64 * 1024,
        activeContextThresholdBytes: 4 * 1024,
        intervalMs: 3_600_000,
        revision: 1,
      });
      listener?.({ type: "progress" });
      listener?.({ type: "subagent-progress", phase: "started", taskId: "task-1" });
      liveTurn = false;
      listener?.({ type: "completed", status: "completed" });
      // The hint falls due while the Agent still works, waiting for its background task.
      advance(3_600_000);
      await runtime.systemCleaner.settled();
      expect(notices).toEqual([]);
      listener?.({
        type: "subagent-progress",
        phase: "notification",
        taskId: "task-1",
        taskStatus: "completed",
      });
      await runtime.systemCleaner.settled();
      expect(notices).toEqual(["New app item available. Run coforge inbox check."]);
    } finally {
      await runtime.stop();
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });
});
