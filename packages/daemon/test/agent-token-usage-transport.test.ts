import { expect, test } from "bun:test";
import {
  AGENT_CONTEXT_USAGE_METHOD,
  AGENT_CONTEXT_VIEW_AVAILABILITY_METHOD,
  AGENT_SERVICE_TIER_METHOD,
  AGENT_TOKEN_USAGE_METHOD,
  decodeAgentTokenUsage,
  type AgentTokenUsage,
} from "@lrm/coforge-sdk/internal";
import { AgentObservationPublisher } from "#src/connection/agent-observation-publisher";
import type { CentrifugeWorkspaceClient } from "#src/connection/centrifuge-workspace-client";
import { DaemonConnection } from "#src/connection/daemon-connection";
import { captureDaemonLogs } from "./log-capture";

function tokenUsageMessage(overrides: Partial<AgentTokenUsage> = {}): AgentTokenUsage {
  return {
    protocolMajor: 1,
    requestId: "req",
    workspaceId: "w-1",
    computerId: "c-1",
    agentId: "a-1",
    provider: "codex",
    launchId: "launch-1",
    sessionId: "sess-1",
    turnSeq: 1,
    model: "gpt-5.4",
    uncachedInputTokens: 100,
    cacheReadTokens: 500,
    cacheWriteTokens: 0,
    outputTokens: 50,
    observedAtMs: 1_758_000_000_000,
    daemonInstanceId: "d-1",
    clientSeq: 1,
    ...overrides,
  };
}

function fakeSchedule() {
  const scheduled: Array<{ fn: () => void; delayMs: number; cancelled: boolean }> = [];
  return {
    scheduled,
    timing: {
      schedule(fn: () => void, delayMs: number) {
        const entry = { fn, delayMs, cancelled: false };
        scheduled.push(entry);
        return entry;
      },
      cancel(timer: unknown) {
        if (timer && typeof timer === "object" && "cancelled" in timer) {
          (timer as { cancelled: boolean }).cancelled = true;
        }
      },
    },
    runNext() {
      const next = scheduled.find((entry) => !entry.cancelled);
      if (!next) return false;
      next.cancelled = true;
      next.fn();
      return true;
    },
  };
}

test("AgentObservationPublisher retries transient token-usage errors with bounded backoff and preserves order", async () => {
  const clock = fakeSchedule();
  const publisher = new AgentObservationPublisher(
    {
      contextUsage: AGENT_CONTEXT_USAGE_METHOD,
      tokenUsage: AGENT_TOKEN_USAGE_METHOD,
      serviceTier: AGENT_SERVICE_TIER_METHOD,
      contextViewAvailability: AGENT_CONTEXT_VIEW_AVAILABILITY_METHOD,
    },
    { retryDelaysMs: [10, 20], timing: clock.timing },
  );

  let turn1Attempts = 0;
  const delivered: number[] = [];
  const client = {
    rpc: async (_method: string, payload: Uint8Array) => {
      const { turnSeq } = decodeAgentTokenUsage(payload);
      if (turnSeq === 1 && turn1Attempts < 2) {
        turn1Attempts += 1;
        throw turn1Attempts === 1
          ? { code: 100, message: "internal server error", temporary: true }
          : { code: 503, message: "unavailable" };
      }
      delivered.push(turnSeq);
      return new Uint8Array();
    },
  } as unknown as CentrifugeWorkspaceClient;

  publisher.sendTokenUsage(tokenUsageMessage({ turnSeq: 1, clientSeq: 1 }), client);
  publisher.sendTokenUsage(tokenUsageMessage({ turnSeq: 2, clientSeq: 2 }), client);

  await Bun.sleep(0);
  expect(turn1Attempts).toBe(1);
  expect(delivered).toEqual([]);
  expect(clock.scheduled.map((entry) => entry.delayMs)).toEqual([10]);

  expect(clock.runNext()).toBe(true);
  await Bun.sleep(0);
  expect(turn1Attempts).toBe(2);
  expect(delivered).toEqual([]);
  expect(clock.scheduled.map((entry) => entry.delayMs)).toEqual([10, 20]);

  expect(clock.runNext()).toBe(true);
  await Bun.sleep(0);
  expect(delivered).toEqual([1, 2]);
});

test("AgentObservationPublisher drops permanent 4xx rejections immediately without retrying and continues queue", async () => {
  const clock = fakeSchedule();
  const publisher = new AgentObservationPublisher(
    {
      contextUsage: AGENT_CONTEXT_USAGE_METHOD,
      tokenUsage: AGENT_TOKEN_USAGE_METHOD,
      serviceTier: AGENT_SERVICE_TIER_METHOD,
      contextViewAvailability: AGENT_CONTEXT_VIEW_AVAILABILITY_METHOD,
    },
    { retryDelaysMs: [10, 20], timing: clock.timing },
  );

  const attempts: number[] = [];
  const client = {
    rpc: async (_method: string, payload: Uint8Array) => {
      const { turnSeq } = decodeAgentTokenUsage(payload);
      attempts.push(turnSeq);
      if (turnSeq === 1) throw { code: 400, message: "invalid Agent token usage" };
      return new Uint8Array();
    },
  } as unknown as CentrifugeWorkspaceClient;

  const { records } = await captureDaemonLogs(async () => {
    publisher.sendTokenUsage(tokenUsageMessage({ turnSeq: 1, clientSeq: 1 }), client);
    publisher.sendTokenUsage(tokenUsageMessage({ turnSeq: 2, clientSeq: 2 }), client);
    await Bun.sleep(0);
  });

  expect(attempts).toEqual([1, 2]);
  expect(clock.scheduled).toEqual([]);
  expect(records).toContainEqual(
    expect.objectContaining({
      level: "warning",
      properties: expect.objectContaining({
        event: "agent_token_usage:rejected",
        error_code: "400",
        outcome: "failed",
      }),
    }),
  );
});

test("DaemonConnection resets observation connection lifetime on disconnect so queued turns replay on reconnect", async () => {
  let onConnected = () => {};
  let onDisconnected = (_context?: { code: number; reason: string }) => {};
  let rejectTurn1!: (error: Error) => void;
  let connectedPhase = 1;
  const phase1Turns: number[] = [];
  const phase2Turns: number[] = [];
  const client: CentrifugeWorkspaceClient = {
    on(event, callback) {
      if (event === "connected") onConnected = callback as () => void;
      else if (event === "disconnected") onDisconnected = callback as typeof onDisconnected;
    },
    connect() {
      onConnected();
    },
    disconnect() {},
    rpc(method, data) {
      if (method !== AGENT_TOKEN_USAGE_METHOD) return Promise.resolve(new Uint8Array());
      const { turnSeq } = decodeAgentTokenUsage(data);
      if (connectedPhase === 1) {
        phase1Turns.push(turnSeq);
        return new Promise<Uint8Array>((_resolve, reject) => {
          rejectTurn1 = reject;
        });
      }
      phase2Turns.push(turnSeq);
      return Promise.resolve(new Uint8Array());
    },
  };

  const clock = fakeSchedule();
  const connection = new DaemonConnection("wss://cloud.example", () => client, undefined, {
    ...clock.timing,
    now: () => 0,
  });
  try {
    await connection.start("secret", {
      workspaceId: "w-1",
      computerId: "c-1",
      workerInstanceId: "daemon-1",
      serverHttpUrl: "https://cloud.example",
    });

    connection.sendAgentTokenUsage(tokenUsageMessage({ turnSeq: 1, clientSeq: 1 }));
    connection.sendAgentTokenUsage(tokenUsageMessage({ turnSeq: 2, clientSeq: 2 }));
    onDisconnected({ code: 3500, reason: "server restart" });
    rejectTurn1(new Error("disconnected"));
    await Bun.sleep(0);
    connection.sendAgentTokenUsage(tokenUsageMessage({ turnSeq: 3, clientSeq: 3 }));

    expect(phase1Turns).toEqual([1]);

    connectedPhase = 2;
    onConnected();
    await connection.flushTokenUsage(1_000);
    expect(phase2Turns).toEqual([1, 2, 3]);
  } finally {
    await connection.stop();
  }
});

test("AgentObservationPublisher.drainAdditive flushes waiting backoff retries and bounds shutdown wait", async () => {
  const clock = fakeSchedule();
  const publisher = new AgentObservationPublisher(
    {
      contextUsage: AGENT_CONTEXT_USAGE_METHOD,
      tokenUsage: AGENT_TOKEN_USAGE_METHOD,
      serviceTier: AGENT_SERVICE_TIER_METHOD,
      contextViewAvailability: AGENT_CONTEXT_VIEW_AVAILABILITY_METHOD,
    },
    { retryDelaysMs: [10_000], timing: clock.timing },
  );

  let attempts = 0;
  const delivered: number[] = [];
  const client = {
    rpc: async (_method: string, payload: Uint8Array) => {
      attempts += 1;
      if (attempts === 1) throw { code: 500, message: "transient" };
      delivered.push(decodeAgentTokenUsage(payload).turnSeq);
      return new Uint8Array();
    },
  } as unknown as CentrifugeWorkspaceClient;

  publisher.sendTokenUsage(tokenUsageMessage({ turnSeq: 1, clientSeq: 1 }), client);
  await Bun.sleep(0);
  expect(attempts).toBe(1);
  expect(delivered).toEqual([]);

  await publisher.drainAdditive(client, 1_000);
  expect(attempts).toBe(2);
  expect(delivered).toEqual([1]);
});

test("AgentObservationPublisher stops retrying after bounded attempts and bounds pending queue to 128 events", async () => {
  const clock = fakeSchedule();
  const publisher = new AgentObservationPublisher(
    {
      contextUsage: AGENT_CONTEXT_USAGE_METHOD,
      tokenUsage: AGENT_TOKEN_USAGE_METHOD,
      serviceTier: AGENT_SERVICE_TIER_METHOD,
      contextViewAvailability: AGENT_CONTEXT_VIEW_AVAILABILITY_METHOD,
    },
    { retryDelaysMs: [10], timing: clock.timing },
  );

  const delivered: number[] = [];
  let turn1Attempts = 0;
  const client = {
    rpc: async (_method: string, payload: Uint8Array) => {
      const { turnSeq } = decodeAgentTokenUsage(payload);
      if (turnSeq === 1) {
        turn1Attempts += 1;
        throw { code: 500, message: "persistent failure" };
      }
      delivered.push(turnSeq);
      return new Uint8Array();
    },
  } as unknown as CentrifugeWorkspaceClient;

  const { records } = await captureDaemonLogs(async () => {
    publisher.sendTokenUsage(tokenUsageMessage({ turnSeq: 1, clientSeq: 1 }), client);
    publisher.sendTokenUsage(tokenUsageMessage({ turnSeq: 2, clientSeq: 2 }), client);
    await Bun.sleep(0);
    expect(clock.runNext()).toBe(true);
    await Bun.sleep(0);
  });

  expect(turn1Attempts).toBe(2);
  expect(delivered).toEqual([2]);
  expect(records).toContainEqual(
    expect.objectContaining({
      level: "warning",
      properties: expect.objectContaining({
        event: "agent_token_usage:rejected",
        error_code: "500",
        attempts: 1,
        outcome: "failed",
      }),
    }),
  );

  publisher.resetConnectionLifetime();
  for (let seq = 1; seq <= 140; seq += 1) {
    publisher.sendTokenUsage(tokenUsageMessage({ turnSeq: seq, clientSeq: seq }));
  }
  const replayed: number[] = [];
  const replayClient = {
    rpc: async (_method: string, payload: Uint8Array) => {
      replayed.push(decodeAgentTokenUsage(payload).turnSeq);
      return new Uint8Array();
    },
  } as unknown as CentrifugeWorkspaceClient;
  publisher.flush(replayClient);
  await publisher.drainAdditive(replayClient, 1_000);
  expect(replayed).toHaveLength(128);
  expect(replayed[0]).toBe(13);
  expect(replayed.at(-1)).toBe(140);
});
