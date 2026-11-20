import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@lrm/coforge-anvil";
import {
  RUNTIME_PROVIDER,
  type DaemonRuntimeUsageScanRequest,
  type DaemonRuntimeUsageScanResponse,
} from "@lrm/coforge-sdk/internal";
import { parseAgentLaunchConfig } from "#src/connection/agent-launch-response";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { DaemonRuntime } from "#src/daemon-runtime/runtime";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";

test("a managed Start proves the revision of its fetched environment, including when Start was queued before a save", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "coforge-agent-usage-launch-"));
  const scope = { workspaceId: "workspace-a", computerId: "computer-a" };
  const connection = { ...scope, workspaceRoot };
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(scope.workspaceId, scope.computerId, "fixture-token");
  const provider = RUNTIME_PROVIDER.CODEX;
  const agentId = "usage-launch-agent";
  const apiKey = `sk_agent_${"a".repeat(43)}`;
  const alpha = join(workspaceRoot, "alpha");
  const beta = join(workspaceRoot, "beta");
  let launchResponse: {
    apiKey: string;
    envVars: { CODEX_HOME: string };
    runtimeConfigRevision?: number;
  } = { apiKey, envVars: { CODEX_HOME: alpha }, runtimeConfigRevision: 1 };
  const fetchStarted = Promise.withResolvers<void>();
  const allowRead = Promise.withResolvers<void>();
  let waitForSave = true;
  let failLaunch = false;
  const startedHomes: (string | undefined)[] = [];
  const answers: DaemonRuntimeUsageScanResponse[] = [];
  let usageHandler: ((request: DaemonRuntimeUsageScanRequest) => Promise<void>) | undefined;
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider,
      async createAgentSession(options) {
        const codexHome = options.runtime?.envVars?.CODEX_HOME;
        startedHomes.push(codexHome);
        if (failLaunch) throw new Error("fixture launch rejected");
        let onEvent: Parameters<AgentSession["subscribe"]>[0] = () => {};
        return {
          async sendMessage() {
            onEvent({ type: "completed", status: "completed" });
          },
          async notify() {},
          subscribe(listener) {
            onEvent = listener;
            return () => {};
          },
          onExit() {
            return () => {};
          },
          async interrupt() {},
          async dispose() {},
          async readUsage() {
            return {
              provider,
              accountLabel: codexHome === beta ? "b***@example.test" : "a***@example.test",
            };
          },
        } satisfies AgentSession;
      },
    }),
    credentials,
    {
      create: () => ({
        async start() {},
        async ready() {},
        async stop() {},
        async requestAgentLaunchConfig() {
          if (waitForSave) {
            fetchStarted.resolve();
            await allowRead.promise;
          }
          return parseAgentLaunchConfig(launchResponse);
        },
        async revokeAgentApiKey() {},
        onUsageScan(listener) {
          usageHandler = listener;
          return () => {};
        },
        async sendUsageScanResult(response) {
          answers.push(response);
        },
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
    join(workspaceRoot, "state"),
  );
  const start = (epoch: number, agentConfigRevision: number) =>
    runtime.handleAgentStart({
      ...scope,
      protocolMajor: 1,
      requestId: `start-${epoch}`,
      launchId: `launch-${epoch}`,
      controlEpoch: epoch,
      agentId,
      provider,
      model: "default",
      reasoning: "balanced",
      agentConfigRevision,
    });
  const scan = (expectedRuntimeConfigRevision: number) =>
    usageHandler!({
      ...scope,
      protocolMajor: 1,
      requestId: `scan-${expectedRuntimeConfigRevision}`,
      provider,
      agentId,
      expectedRuntimeConfigRevision,
    });

  try {
    await runtime.start(connection);
    const queued = start(1, 1);
    await fetchStarted.promise;
    launchResponse = { apiKey, envVars: { CODEX_HOME: beta }, runtimeConfigRevision: 2 };
    waitForSave = false;
    allowRead.resolve();
    expect((await queued).effectiveConfigRevision).toBe(2);

    await scan(1);
    expect(answers).toHaveLength(0);
    await scan(2);
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({
      agentId,
      effectiveRuntimeConfigRevision: 2,
      status: "available",
    });
    expect(JSON.parse(new TextDecoder().decode(answers[0]?.snapshotJson))).toMatchObject({
      accountLabel: "b***@example.test",
    });

    launchResponse = { apiKey, envVars: { CODEX_HOME: alpha }, runtimeConfigRevision: 3 };
    await scan(3);
    expect(answers).toHaveLength(1);

    await runtime.stopAgent(agentId);
    launchResponse = { apiKey, envVars: { CODEX_HOME: alpha } };
    expect((await start(2, 2)).effectiveConfigRevision).toBeUndefined();
    expect(startedHomes).toEqual([beta, alpha]);
    await scan(2);
    expect(answers).toHaveLength(1);

    await runtime.stopAgent(agentId);
    launchResponse = { apiKey, envVars: { CODEX_HOME: alpha }, runtimeConfigRevision: 3 };
    failLaunch = true;
    await expect(start(3, 3)).rejects.toThrow("Agent managed launch did not complete");
    expect(startedHomes).toEqual([beta, alpha, alpha]);
    await scan(2);
    await scan(3);
    expect(answers).toHaveLength(1);
  } finally {
    allowRead.resolve();
    await runtime.stop();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
