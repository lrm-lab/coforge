import { afterAll, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import type { ReminderSync } from "@lrm/coforge-sdk/internal";
import {
  DaemonRuntime,
  type AgentRuntimeConfig,
  type WorkspaceConfig,
} from "#src/daemon-runtime/runtime";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { sessionSpy } from "./fixtures/session-spy";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";

const tempRoot = realpathSync(tmpdir());
const workspaceRoot = join(tempRoot, `coforge-reminder-connection-${crypto.randomUUID()}`);
const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot,
};
const config: AgentRuntimeConfig = {
  provider: "pi",
  model: "default",
  modelProvider: "anthropic",
  reasoning: "balanced",
};
const reminderId = "123e4567-e89b-42d3-a456-426614174000";
const agentLaunchConfig = (agentApiKey: string) => ({ agentApiKey, providerConfig: undefined });

afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));

const sync = (agentId: string, overdue: boolean): ReminderSync => ({
  protocolMajor: 1,
  requestId: "reminder-snapshot",
  workspaceId: connection.workspaceId,
  computerId: connection.computerId,
  agentId,
  operation: "snapshot",
  jobs: overdue
    ? [
        {
          reminderId,
          ownerAgentId: agentId,
          version: 1,
          title: "Review",
          target: "@frank",
          messageId: "123e4567-e89b-42d3-a456-426614174001",
          fireAt: new Date(Date.now() - 60_000).toISOString(),
        },
      ]
    : [],
  messageType: "coforge.rpc.v1.ReminderSync",
});

type Harness = {
  asked: string[];
  fired: Promise<string>;
  reconnect: () => void;
  runtime: DaemonRuntime;
  stateDirectory: string;
};

async function harness(options: {
  overdue: boolean;
  createSession: () => Promise<ReturnType<typeof sessionSpy>>;
}): Promise<Harness> {
  const stateDirectory = join(tempRoot, `coforge-reminder-connect-state-${crypto.randomUUID()}`);
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const asked: string[] = [];
  const fired = Promise.withResolvers<string>();
  let reconnect: (() => void) | undefined;
  const transport: DaemonConnectionClient = {
    async start() {},
    async ready() {},
    async stop() {},
    onReconnect(callback) {
      reconnect = callback;
      return () => undefined;
    },
    async requestSnapshot(request) {
      asked.push(request.agentId);
      return sync(request.agentId, options.overdue);
    },
    async fireReminder(request) {
      fired.resolve(request.reminderId);
      return { ...request, result: "accepted", fired: true, catchup: false } as const;
    },
    async requestAgentLaunchConfig() {
      return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
    },
    async revokeAgentApiKey() {},
  };
  const runtime = new DaemonRuntime(
    connection,
    () => ({ provider: "pi", createAgentSession: options.createSession }),
    credentials,
    { create: () => transport },
    undefined,
    emptyCodeAgentDiscovery,
    stateDirectory,
  );
  return {
    asked,
    fired: fired.promise,
    reconnect: () => reconnect!(),
    runtime,
    stateDirectory,
  };
}

/** 2026-11-16: a Daemon that connected before its Agent was ready never asked for that Agent's
 * reminders, so nothing asked again and they never fired. */
test("an Agent that starts after the daemon connected still gets its overdue reminder", async () => {
  const built = await harness({ overdue: true, createSession: async () => sessionSpy() });
  try {
    await built.runtime.start(connection);
    expect(built.asked).toEqual([]);
    await built.runtime.startAgent("agent-a", config);
    expect(await built.fired).toBe(reminderId);
    expect(built.asked).toEqual(["agent-a"]);
  } finally {
    await built.runtime.stop();
    await rm(built.stateDirectory, { recursive: true, force: true });
  }
});

test("a connection asks for an Agent whose launch is still in flight", async () => {
  const gate = Promise.withResolvers<void>();
  const built = await harness({
    overdue: false,
    createSession: async () => {
      await gate.promise;
      return sessionSpy();
    },
  });
  try {
    await built.runtime.start(connection);
    const starting = built.runtime.startAgent("agent-a", config);
    await Bun.sleep(0);
    expect(built.asked).toEqual(["agent-a"]);
    built.reconnect();
    expect(built.asked).toEqual(["agent-a", "agent-a"]);
    gate.resolve();
    await starting;
  } finally {
    gate.resolve();
    await built.runtime.stop();
    await rm(built.stateDirectory, { recursive: true, force: true });
  }
});
