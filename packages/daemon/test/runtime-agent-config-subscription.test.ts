import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfigSync } from "@lrm/coforge-sdk/internal";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { DaemonRuntime, type WorkspaceConfig } from "#src/daemon-runtime/runtime";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import { captureDaemonLogs } from "./log-capture";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";
import { sessionSpy } from "./fixtures/session-spy";

const workspaceRoot = join(realpathSync(tmpdir()), `coforge-config-push-${crypto.randomUUID()}`);
const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot,
};

const push = (revision: number): AgentConfigSync => ({
  protocolMajor: 1,
  workspaceId: connection.workspaceId,
  computerId: connection.computerId,
  agentId: "agent-a",
  provider: "pi",
  model: "default",
  reasoning: "balanced",
  revision,
});

const isConfigPush = (record: { properties: Record<string, unknown> }) =>
  record.properties.event === "agent.runtime.config_push";

test("a config push held before ready reaches the apply module after ready, newest only", async () => {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const subscribed = Promise.withResolvers<(sync: AgentConfigSync) => void>();
  const answer = Promise.withResolvers<void>();
  const runtime = new DaemonRuntime(
    connection,
    () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
    credentials,
    {
      create: () =>
        ({
          async start() {},
          onAgentConfigSync(handler: (sync: AgentConfigSync) => void) {
            subscribed.resolve(handler);
            return () => {};
          },
          ready: () => answer.promise,
          async stop() {},
        }) as unknown as DaemonConnectionClient,
    },
    undefined,
    emptyCodeAgentDiscovery,
    workspaceRoot,
  );
  try {
    const { records } = await captureDaemonLogs(async (records) => {
      const starting = runtime.start(connection);
      const deliver = await subscribed.promise;
      deliver(push(1));
      deliver(push(2));
      expect(records.filter(isConfigPush)).toEqual([]);
      answer.resolve();
      await starting;
    });
    const pushes = records.filter(isConfigPush);
    // No runtime and no restart config: nothing to update, and only the newest push was seen.
    expect(
      pushes.map((record) => [record.properties.outcome, record.properties.config_revision]),
    ).toEqual([["no_restart_config", 2]]);
  } finally {
    await runtime.stop();
  }
});
