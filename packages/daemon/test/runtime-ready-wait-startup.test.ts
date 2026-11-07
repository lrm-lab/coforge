import { afterEach, expect, jest, test } from "bun:test";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentStopIntent, DaemonRuntimeReadyRequest } from "@lrm/coforge-sdk/internal";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { DaemonRuntime, type WorkspaceConfig } from "#src/daemon-runtime/runtime";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import {
  READY_WAIT_LOG_REPEAT_MS,
  READY_WAIT_LOG_TIMEOUT_MS,
} from "#src/daemon-runtime/runtime-ready-wait";
import { captureDaemonLogs } from "./log-capture";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";
import { sessionSpy } from "./fixtures/session-spy";

afterEach(() => jest.useRealTimers());

const workspaceRoot = join(realpathSync(tmpdir()), `coforge-ready-wait-${crypto.randomUUID()}`);
const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot,
};

/**
 * A Workspace whose first ready the test drives by hand. The fake transport keeps the handshake
 * pending and asks for a fresh request each attempt, which is how the real connection retries, so
 * the test decides how many attempts a hold outlasts before the handshake answers.
 */
async function heldStartup() {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  let stop!: (intent: AgentStopIntent) => void;
  const handshakePending = Promise.withResolvers<{
    attempt: () => void;
    answer: () => void;
  }>();
  const runtime = new DaemonRuntime(
    connection,
    () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
    credentials,
    {
      create: () =>
        ({
          async start() {},
          onAgentStop(handler: (intent: AgentStopIntent) => void) {
            stop = handler;
            return () => {};
          },
          ready: (createRequest: () => DaemonRuntimeReadyRequest) => {
            createRequest();
            const settled = Promise.withResolvers<void>();
            handshakePending.resolve({
              attempt: () => void createRequest(),
              answer: () => settled.resolve(),
            });
            return settled.promise;
          },
          async stop() {},
        }) as unknown as DaemonConnectionClient,
    },
    undefined,
    emptyCodeAgentDiscovery,
    workspaceRoot,
  );
  return {
    runtime,
    held: handshakePending.promise,
    // A publication the hold keeps: the stop of an Agent that was still starting.
    stopAgent: (agentId: string) =>
      stop({
        protocolMajor: 1,
        requestId: `stop-${agentId}`,
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        agentId,
      }),
  };
}

test("a ready retried as it fails reports the hold and the attempts behind it", async () => {
  jest.useFakeTimers();
  const startup = await heldStartup();
  const { records } = await captureDaemonLogs(async () => {
    const starting = startup.runtime.start(connection);
    const held = await startup.held;
    startup.stopAgent("agent-a");
    // Each attempt answers in three seconds and is retried: no single one comes near the
    // threshold, yet the publication stays held well past it.
    for (let attempt = 1; attempt <= 40; attempt += 1) {
      held.attempt();
      jest.advanceTimersByTime(3_000);
    }
    held.answer();
    await starting;
  });
  jest.useRealTimers();
  await startup.runtime.stop();

  const waits = records.filter((record) => record.properties.event === "runtime:ready_wait_long");
  expect(waits.length).toBeGreaterThanOrEqual(1);
  expect(waits[0]?.properties).toMatchObject({
    workspace_id: connection.workspaceId,
    held_control_count: 1,
    ready_attempts: 41,
  });
  expect(Number(waits[0]?.properties.waited_ms)).toBeGreaterThanOrEqual(READY_WAIT_LOG_TIMEOUT_MS);
});

test("a hold still not released repeats its report until the handshake answers", async () => {
  jest.useFakeTimers();
  const startup = await heldStartup();
  const { records } = await captureDaemonLogs(async () => {
    const starting = startup.runtime.start(connection);
    const held = await startup.held;
    jest.advanceTimersByTime(READY_WAIT_LOG_TIMEOUT_MS + READY_WAIT_LOG_REPEAT_MS);
    held.answer();
    await starting;
    // Released: nothing more is reported, however long the runtime then runs.
    jest.advanceTimersByTime(READY_WAIT_LOG_REPEAT_MS * 3);
  });
  jest.useRealTimers();
  await startup.runtime.stop();

  const waits = records.filter((record) => record.properties.event === "runtime:ready_wait_long");
  expect(waits).toHaveLength(2);
  expect(Number(waits[1]?.properties.waited_ms)).toBeGreaterThan(
    Number(waits[0]?.properties.waited_ms),
  );
});

test("a handshake that answers in time reports nothing, even long after", async () => {
  jest.useFakeTimers();
  const startup = await heldStartup();
  const { records } = await captureDaemonLogs(async () => {
    const starting = startup.runtime.start(connection);
    const held = await startup.held;
    held.answer();
    await starting;
    jest.advanceTimersByTime(READY_WAIT_LOG_TIMEOUT_MS * 3);
  });
  jest.useRealTimers();
  await startup.runtime.stop();

  expect(records.some((record) => record.properties.event === "runtime:ready_wait_long")).toBe(
    false,
  );
});
