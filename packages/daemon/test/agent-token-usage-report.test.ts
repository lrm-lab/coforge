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
import { AgentUsageReport } from "#src/daemon-runtime/agent-usage-report";
import { captureDaemonLogs } from "./log-capture";

test("AgentUsageReport accumulates deltas within a turn and increments turnSeq per launch", () => {
  const sent: AgentTokenUsage[] = [];
  const seqs: number[] = [];
  const report = new AgentUsageReport({
    sessionId: () => "native-sess",
    envelope: () => ({
      protocolMajor: 1,
      requestId: "req",
      workspaceId: "w-1",
      computerId: "c-1",
    }),
    daemonInstanceId: () => "daemon-1",
    recordClientSeq: (_agentId, seq) => seqs.push(seq),
    sendContextUsage: () => {},
    sendServiceTier: () => {},
    sendTokenUsage: (msg) => sent.push(msg),
  });
  const launch = { launchId: "launch-1", clientSeq: 0, stopping: false };

  report.recordTokenUsage("a-1", {
    uncachedInputTokens: 1_000,
    cacheReadTokens: 8_000,
    cacheWriteTokens: 200,
    outputTokens: 150,
    model: "gpt-5.4",
    contextUsedTokens: 9_200,
    contextWindowTokens: 200_000,
    occurredAt: "2026-11-24T02:00:00.000Z",
  });
  report.recordTokenUsage("a-1", {
    uncachedInputTokens: 500,
    cacheReadTokens: 10_000,
    cacheWriteTokens: 0,
    outputTokens: 250,
    reasoningOutputTokens: 80,
    contextUsedTokens: 11_000,
    contextWindowTokens: 200_000,
  });

  expect(report.flushTokenUsage("a-1", launch, "codex", "fallback-model")).toBe(true);
  expect(report.flushTokenUsage("a-1", launch, "codex", "fallback-model")).toBe(false);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    agentId: "a-1",
    provider: "codex",
    launchId: "launch-1",
    sessionId: "native-sess",
    turnSeq: 1,
    model: "gpt-5.4",
    uncachedInputTokens: 1_500,
    cacheReadTokens: 18_000,
    cacheWriteTokens: 200,
    outputTokens: 400,
    reasoningOutputTokens: 80,
    contextUsedTokens: 11_000,
    contextWindowTokens: 200_000,
    clientSeq: 1,
  });

  report.recordTokenUsage("a-1", {
    uncachedInputTokens: 300,
    cacheReadTokens: 9_000,
    cacheWriteTokens: 0,
    outputTokens: 100,
  });
  expect(report.flushTokenUsage("a-1", launch, "codex", "gpt-5.4")).toBe(true);
  expect(sent[1]?.turnSeq).toBe(2);
  expect(sent[1]?.model).toBe("gpt-5.4");
  expect(seqs).toEqual([1, 2]);
});

test("AgentObservationPublisher preserves every additive token-usage turn while offline and in-flight", async () => {
  const publisher = new AgentObservationPublisher({
    contextUsage: AGENT_CONTEXT_USAGE_METHOD,
    tokenUsage: AGENT_TOKEN_USAGE_METHOD,
    serviceTier: AGENT_SERVICE_TIER_METHOD,
    contextViewAvailability: AGENT_CONTEXT_VIEW_AVAILABILITY_METHOD,
  });
  const base: AgentTokenUsage = {
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
  };
  publisher.sendTokenUsage({ ...base, turnSeq: 1, clientSeq: 1 });
  publisher.sendTokenUsage({ ...base, turnSeq: 2, clientSeq: 2 });

  const delivered: number[] = [];
  const client = {
    rpc: async (_method: string, payload: Uint8Array) => {
      delivered.push(decodeAgentTokenUsage(payload).turnSeq);
      return new Uint8Array();
    },
  } as unknown as CentrifugeWorkspaceClient;

  publisher.flush(client);
  await new Promise((r) => setTimeout(r, 20));
  expect(delivered).toEqual([1, 2]);
});

test("AgentUsageReport sanitizes fractional counts and never throws out of flushTokenUsage", () => {
  const sent: AgentTokenUsage[] = [];
  const report = new AgentUsageReport({
    sessionId: () => "native-sess",
    envelope: () => ({
      protocolMajor: 1,
      requestId: "req",
      workspaceId: "w-1",
      computerId: "c-1",
    }),
    daemonInstanceId: () => "daemon-1",
    recordClientSeq: () => {},
    sendContextUsage: () => {},
    sendServiceTier: () => {},
    sendTokenUsage: (msg) => sent.push(msg),
  });
  const launch = { launchId: "launch-1", clientSeq: 0, stopping: false };
  report.contextUsage("a-1", launch, "claude-code", 1234.6, 200_000.4);
  report.recordTokenUsage("a-1", {
    uncachedInputTokens: 100.4,
    cacheReadTokens: -5,
    cacheWriteTokens: Number.NaN,
    outputTokens: 50.6,
  });
  expect(report.flushTokenUsage("a-1", launch, "claude-code", "claude-sonnet-4-6")).toBe(true);
  expect(sent[0]).toMatchObject({
    uncachedInputTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 51,
    contextUsedTokens: 1235,
    contextWindowTokens: 200_000,
  });

  const throwing = new AgentUsageReport({
    sessionId: () => "native-sess",
    envelope: () => ({
      protocolMajor: 1,
      requestId: "req",
      workspaceId: "w-1",
      computerId: "c-1",
    }),
    daemonInstanceId: () => "daemon-1",
    recordClientSeq: () => {},
    sendContextUsage: () => {},
    sendServiceTier: () => {},
    sendTokenUsage: () => {
      throw new Error("codec failure");
    },
  });
  throwing.recordTokenUsage("a-1", {
    uncachedInputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 5,
  });
  expect(throwing.flushTokenUsage("a-1", launch, "codex", "gpt-5.4")).toBe(false);
});

test("AgentObservationPublisher delivers queued token-usage turns onto a reconnected client", async () => {
  const publisher = new AgentObservationPublisher({
    contextUsage: AGENT_CONTEXT_USAGE_METHOD,
    tokenUsage: AGENT_TOKEN_USAGE_METHOD,
    serviceTier: AGENT_SERVICE_TIER_METHOD,
    contextViewAvailability: AGENT_CONTEXT_VIEW_AVAILABILITY_METHOD,
  });
  const base: AgentTokenUsage = {
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
  };

  let rejectTurn1!: (error: Error) => void;
  const client1Calls: number[] = [];
  const client1 = {
    rpc: (_method: string, payload: Uint8Array) => {
      client1Calls.push(decodeAgentTokenUsage(payload).turnSeq);
      return new Promise<Uint8Array>((_resolve, reject) => {
        rejectTurn1 = reject;
      });
    },
  } as unknown as CentrifugeWorkspaceClient;

  const client2Calls: number[] = [];
  const client2 = {
    rpc: async (_method: string, payload: Uint8Array) => {
      client2Calls.push(decodeAgentTokenUsage(payload).turnSeq);
      return new Uint8Array();
    },
  } as unknown as CentrifugeWorkspaceClient;

  publisher.sendTokenUsage({ ...base, turnSeq: 1, clientSeq: 1 }, client1);
  publisher.sendTokenUsage({ ...base, turnSeq: 2, clientSeq: 2 }, client1);
  publisher.resetConnectionLifetime();
  publisher.flush(client2);
  rejectTurn1(new Error("disconnected"));
  await new Promise((r) => setTimeout(r, 20));

  expect(client1Calls).toEqual([1]);
  expect(client2Calls).toEqual([1, 2]);
});

test("AgentUsageReport logs a structured warning when token usage sending throws", async () => {
  const launch = { launchId: "launch-1", clientSeq: 0, stopping: false };
  const throwing = new AgentUsageReport({
    sessionId: () => "native-sess",
    envelope: () => ({
      protocolMajor: 1,
      requestId: "req-err",
      workspaceId: "w-1",
      computerId: "c-1",
    }),
    daemonInstanceId: () => "daemon-1",
    recordClientSeq: () => {},
    sendContextUsage: () => {},
    sendServiceTier: () => {},
    sendTokenUsage: () => {
      throw new RangeError("invalid token usage");
    },
  });
  throwing.recordTokenUsage("a-1", {
    uncachedInputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 5,
  });

  const { result, records } = await captureDaemonLogs(async () =>
    throwing.flushTokenUsage("a-1", launch, "codex", "gpt-5.4"),
  );
  expect(result).toBe(false);
  expect(records).toContainEqual(
    expect.objectContaining({
      level: "warning",
      properties: expect.objectContaining({
        event: "agent_token_usage:encode_failed",
        request_id: "req-err",
        workspace_id: "w-1",
        computer_id: "c-1",
        agent_id: "a-1",
        launch_id: "launch-1",
        turn_seq: 1,
        provider: "codex",
        error_code: "RangeError",
        outcome: "failed",
      }),
    }),
  );
});

test("AgentUsageReport isolates conversation buckets, flushes all buckets, and preserves turnSeq across forget for the same launch", () => {
  const sent: AgentTokenUsage[] = [];
  const report = new AgentUsageReport({
    sessionId: () => "native-sess",
    envelope: () => ({
      protocolMajor: 1,
      requestId: "req",
      workspaceId: "w-1",
      computerId: "c-1",
    }),
    daemonInstanceId: () => "daemon-1",
    recordClientSeq: () => {},
    sendContextUsage: () => {},
    sendServiceTier: () => {},
    sendTokenUsage: (msg) => sent.push(msg),
  });
  const launch = { launchId: "launch-1", clientSeq: 0, stopping: false };
  report.contextUsage("a-1", launch, "codex", 12_000, 200_000);
  report.recordTokenUsage("a-1", {
    uncachedInputTokens: 1_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 200,
  });
  report.recordTokenUsage(
    "a-1",
    {
      uncachedInputTokens: 300,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 50,
    },
    "conv-side",
  );

  expect(report.flushTokenUsage("a-1", launch, "codex", "gpt-5.4", "conv-side")).toBe(true);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    turnSeq: 1,
    uncachedInputTokens: 300,
    outputTokens: 50,
  });
  expect(sent[0]?.contextUsedTokens).toBeUndefined();

  report.recordTokenUsage(
    "a-1",
    {
      uncachedInputTokens: 400,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 60,
    },
    "conv-2",
  );
  expect(report.flushAllTokenUsage("a-1", launch, "codex", "gpt-5.4")).toBe(2);
  expect(sent.map((entry) => [entry.turnSeq, entry.uncachedInputTokens])).toEqual([
    [1, 300],
    [2, 1_000],
    [3, 400],
  ]);
  expect(sent[1]?.contextUsedTokens).toBe(12_000);

  report.forget("a-1");
  report.recordTokenUsage("a-1", {
    uncachedInputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 10,
  });
  expect(report.flushTokenUsage("a-1", launch, "codex", "gpt-5.4")).toBe(true);
  expect(sent[3]?.turnSeq).toBe(4);

  const nextLaunch = { launchId: "launch-2", clientSeq: 0, stopping: false };
  report.recordTokenUsage("a-1", {
    uncachedInputTokens: 70,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 20,
  });
  expect(report.flushTokenUsage("a-1", nextLaunch, "codex", "gpt-5.4")).toBe(true);
  expect(sent[4]?.turnSeq).toBe(1);
});
