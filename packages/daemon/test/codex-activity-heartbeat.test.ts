import { afterAll, afterEach, expect, jest, test } from "bun:test";
import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceConfig } from "#src/daemon-runtime/runtime";
import { type CodeAgentProvider, PROCESS_TREE_EXIT_GRACE_MS } from "@lrm/coforge-anvil";
import { CodexProvider } from "#src/code-agent/codex/provider";
import { DAEMON_SHUTDOWN_NOTICE_TIMEOUT_MS } from "#src/connection/shutdown-notice-timeout";
import { activityHarness } from "./fixtures/activity-runtime";

// macOS tmpdir lives under /var, a symlink; the state store rejects linked ancesto
const tempRoot = realpathSync(tmpdir());
const workspaceRoot = join(tempRoot, `coforge-activity-heartbeat-${crypto.randomUUID()}`);
const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot,
};

afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));
afterEach(() => jest.useRealTimers());

const harness = (provider?: CodeAgentProvider) => activityHarness(connection, provider);

for (const completionOrder of ["running", "before-start-response"] as const) {
  test(
    `Codex late items cannot restart Busy or its heartbeat (${completionOrder})`,
    async () => {
      const provider = new CodexProvider({
        command: [
          process.execPath,
          new URL("./fixtures/codex-app-server.ts", import.meta.url).pathname,
        ],
      });
      const { runtime, session, activities } = await harness(provider);
      try {
        // The shared launch now opens a startup turn. End it through the fixture's native
        // turn protocol before exercising a separate turn's late-event reconciliation.
        let unsubscribeStartup = () => {};
        const startupEnded = new Promise<void>((resolve) => {
          unsubscribeStartup = session.subscribe((event) => {
            if (event.type === "completed") resolve();
          });
        });
        try {
          await session.notify!("finish-with-late-events");
          await startupEnded;
        } finally {
          unsubscribeStartup();
        }
        jest.useFakeTimers();
        activities.length = 0;
        if (completionOrder === "running") {
          await session.sendMessage("hold");
          await session.notify!("finish-with-late-events");
        } else {
          await session.sendMessage("finish-before-response");
        }
        const idleIndex = activities.findIndex((activity) => activity.detailKind === "idle");
        expect(idleIndex).toBeGreaterThanOrEqual(0);
        expect(activities.slice(idleIndex + 1)).toEqual([]);
        expect(runtime.busyAgents()).toEqual([]);

        const countAfterCompletion = activities.length;
        jest.advanceTimersByTime(600_000);
        expect(activities).toHaveLength(countAfterCompletion);
        jest.useRealTimers();

        // The session remains usable: an idle notice starts a fresh native turn.
        activities.length = 0;
        let unsubscribe = () => {};
        const responded = new Promise<void>((resolve) => {
          unsubscribe = session.subscribe((event) => {
            if (event.type === "tool-start" && event.id === "current-command") resolve();
          });
        });
        try {
          await session.notify!("hold-tool");
          await responded;
        } finally {
          unsubscribe();
        }
        expect(runtime.busyAgents().map((agent) => agent.agentId)).toEqual(["agent-a"]);
        expect(activities.some((activity) => activity.detailKind === "running_command")).toBe(true);
      } finally {
        jest.useRealTimers();
        await runtime.stop();
      }
    },
    5_000 + 2 * PROCESS_TREE_EXIT_GRACE_MS + DAEMON_SHUTDOWN_NOTICE_TIMEOUT_MS,
  );
}
