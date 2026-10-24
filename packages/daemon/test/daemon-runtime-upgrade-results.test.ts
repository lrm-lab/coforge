import { afterAll, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UPGRADE_ERROR_CODE } from "@lrm/coforge-sdk/internal";
import type { AgentSession } from "@lrm/coforge-anvil";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { DaemonRuntime, type WorkspaceConfig } from "#src/daemon-runtime/runtime";
import {
  UPGRADE_RESULT_POLL_MS,
  type RecoveredUpgradeResult,
} from "#src/daemon-runtime/upgrade-result-reporter";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";

// macOS tmpdir lives under /var, a symlink; the state store rejects linked ancestors.
const workspaceRoot = join(
  realpathSync(tmpdir()),
  `coforge-daemon-upgrade-results-${crypto.randomUUID()}`,
);
const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot,
};
afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));

const session = {
  async sendMessage() {},
  subscribe: () => () => undefined,
  async interrupt() {},
  onExit: () => () => undefined,
  async dispose() {},
} satisfies AgentSession;

type Timer = { callback: () => Promise<void>; milliseconds: number; cancelled: boolean };

/** The reporter's timers, held for the test to fire; `next` resolves once one is armed, and
 * `fire` awaits the pass its callback starts. */
function heldTimers() {
  const timers: Timer[] = [];
  let armed: (() => void) | undefined;
  const live = () => timers.filter((timer) => !timer.cancelled);
  return {
    timers,
    live,
    schedule(callback: () => Promise<void>, milliseconds: number) {
      const timer = { callback, milliseconds, cancelled: false };
      timers.push(timer);
      armed?.();
      return () => {
        timer.cancelled = true;
      };
    },
    async next(): Promise<Timer> {
      while (live().length === 0) await new Promise<void>((resolve) => (armed = resolve));
      return live()[0]!;
    },
    async fire(timer: Timer) {
      timer.cancelled = true;
      await timer.callback();
    },
  };
}

/** A runtime whose Coordinator accepts every upgrade request once `accept` resolves; `config` is
 * what the Coordinator's rewrites of this child's config say. */
async function upgradeRuntime(accept: () => Promise<void>) {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-upgrade");
  const config = { results: [] as RecoveredUpgradeResult[], pending: false, reads: 0 };
  const sent: { requestId: string; status: string; errorCode?: string }[] = [];
  const acknowledged: string[] = [];
  const timers = heldTimers();
  let requestUpgrade: ((requestId: string, expectedVersion?: string) => Promise<void>) | undefined;
  const runtime = new DaemonRuntime(
    connection,
    () => ({ provider: "pi", createAgentSession: async () => session }),
    credentials,
    {
      create: () => ({
        async start(_token, transportConfig) {
          requestUpgrade = transportConfig.requestUpgrade;
        },
        async stop() {},
        async ready() {},
        async sendUpgradeResult(result) {
          sent.push(result);
          return true;
        },
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
    workspaceRoot,
    {
      requestUpgrade: async () => {
        await accept();
        config.pending = true;
      },
      readUpgradeOperations: async () => {
        config.reads += 1;
        return {
          results: config.results.filter((result) => !acknowledged.includes(result.requestId)),
          pending: config.pending,
        };
      },
      acknowledgeUpgradeResult: async (requestId) => {
        acknowledged.push(requestId);
      },
      upgradeResultSchedule: timers.schedule,
    },
  );
  await runtime.start(connection);
  return { runtime, config, sent, acknowledged, timers, requestUpgrade: requestUpgrade! };
}

test("an upgrade that fails while this Workspace stays online is reported within one poll tick, with its code", async () => {
  const { runtime, config, sent, acknowledged, timers, requestUpgrade } = await upgradeRuntime(
    async () => {},
  );
  try {
    await requestUpgrade("upgrade-online", "2.0.0");
    // The accepted request is pending in the config, so the reporter polls it.
    const poll = await timers.next();
    expect(poll.milliseconds).toBe(UPGRADE_RESULT_POLL_MS);
    // The installer job fails downloading; the old process is never stopped.
    config.pending = false;
    config.results.push({
      requestId: "upgrade-online",
      status: "failed",
      completedAtMs: 2_000,
      error: "download failed",
      errorCode: UPGRADE_ERROR_CODE.UPDATE_INTEGRITY_FAILED,
    });
    expect(sent).toEqual([]);
    await timers.fire(poll);
    expect(sent).toEqual([
      expect.objectContaining({
        requestId: "upgrade-online",
        status: "failed",
        errorCode: UPGRADE_ERROR_CODE.UPDATE_INTEGRITY_FAILED,
      }),
    ]);
    expect(acknowledged).toEqual(["upgrade-online"]);
    expect(timers.live()).toEqual([]);
  } finally {
    await runtime.stop();
  }
});

test("an upgrade request the Coordinator accepts after the runtime stopped leaves no timer behind", async () => {
  let accept!: () => void;
  const accepted = new Promise<void>((resolve) => (accept = resolve));
  const { runtime, config, timers, requestUpgrade } = await upgradeRuntime(() => accepted);
  try {
    const request = requestUpgrade("upgrade-late", "2.0.0");
    await runtime.stop();
    const readsAtStop = config.reads;
    accept();
    await request;
    // A pass would have read the config synchronously, inside the request's own continuation.
    expect(config.reads).toBe(readsAtStop);
    expect(timers.timers).toEqual([]);
  } finally {
    await runtime.stop();
  }
});
