import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReminderFireRequest, ReminderSync } from "@lrm/coforge-sdk/internal";
import { DaemonRuntime, type WorkspaceConfig } from "#src/daemon-runtime/runtime";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";

const tempRoot = realpathSync(tmpdir());
const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot: join(tempRoot, `coforge-unrequested-snapshot-${crypto.randomUUID()}`),
};
afterAll(() => rm(connection.workspaceRoot, { recursive: true, force: true }));

/** Resolves the promise or throws, so a snapshot that never arms fails instead of hanging. */
async function within<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`nothing happened within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The server pushes a snapshot for every Agent on this Computer when the Daemon connects, and most
 * of those Agents are not running: the Daemon only knows the ones it was asked to start. The
 * snapshot has to arm the timer anyway, or an Agent that has never run on this machine never wakes
 * for its reminders. The scheduler authorises from the snapshot itself, so this asserts the pushed
 * frame reaches the fire path with no Agent process and no `agent:start` in the run.
 */
test("a pushed snapshot is armed and fired for an Agent that never started here", async () => {
  const stateDirectory = join(tempRoot, `coforge-unrequested-state-${crypto.randomUUID()}`);
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  let receiveReminder!: (sync: ReminderSync) => void;
  const fired = Promise.withResolvers<ReminderFireRequest>();
  let sessions = 0;
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "pi",
      async createAgentSession() {
        sessions++;
        return {
          async sendMessage() {},
          subscribe: () => () => undefined,
          async interrupt() {},
          onExit: () => () => undefined,
          async dispose() {},
        };
      },
    }),
    credentials,
    {
      create: () => ({
        async start() {},
        async ready() {},
        async stop() {},
        onReminderSync(callback) {
          receiveReminder = callback;
          return () => undefined;
        },
        async fireReminder(request) {
          fired.resolve(request);
          return { ...request, result: "accepted", fired: true, catchup: true } as const;
        },
        async requestAgentLaunchConfig() {
          return { agentApiKey: `sk_agent_${"a".repeat(43)}` };
        },
        async revokeAgentApiKey() {},
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
    stateDirectory,
  );
  try {
    await runtime.start(connection);

    receiveReminder({
      protocolMajor: 1,
      requestId: "pushed-snapshot",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-cold",
      operation: "snapshot",
      messageType: "coforge.rpc.v1.ReminderSync",
      jobs: [
        {
          reminderId: "4d5f2b1a-0a4e-4f43-9f8e-2e0b4c1d9a11",
          ownerAgentId: "agent-cold",
          version: 1,
          title: "Wake a cold Agent",
          target: "@frank",
          messageId: "123e4567-e89b-42d3-a456-426614174001",
          fireAt: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
    });

    const request = await within(fired.promise);
    expect(request).toMatchObject({
      agentId: "agent-cold",
      reminderId: "4d5f2b1a-0a4e-4f43-9f8e-2e0b4c1d9a11",
      version: 1,
    });
    // Nothing was ever started for it: the arm came from the snapshot alone.
    expect(sessions).toBe(0);
  } finally {
    await runtime.stop();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});
