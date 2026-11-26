import { expect, test } from "bun:test";
import { RUNTIME_PROVIDER, type RuntimeProvider } from "@lrm/coforge-sdk/internal";
import { codeAgentProviderCapabilities, createCodeAgentProvider } from "#src/code-agent/registry";
import { ColdIdleSweep } from "#src/daemon-runtime/cold-idle-sweep";
import { composeMessages } from "#src/daemon-runtime/message-composition";

test("composeMessages forwards consumedSeqs.apply so delta writes bypass full-snapshot write()", () => {
  let applyCalls = 0;
  let writeCalls = 0;

  const composed = composeMessages({
    sweeps: { add: () => {} },
    connection: { workspaceId: "ws-1", computerId: "comp-1" },
    stateDirectory: "/tmp/coforge-r6-test-unused",
    transport: () =>
      ({
        sendAgentMentionDeliveryTransition: async () => {},
      }) as never,
    consumedSeqs: {
      read: () => ({ targets: {}, aliases: {} }),
      write: () => {
        writeCalls += 1;
      },
      apply: () => {
        applyCalls += 1;
      },
    } as never,
    deliveryGate: {
      pending: () => false,
      enqueue: () => {},
      busy: () => {},
      isBusy: () => false,
      hasQueued: () => false,
    } as never,
    runtimeRelease: {} as never,
    processManager: {
      session: () => undefined,
    } as never,
    launchCustody: () =>
      ({
        noteTurnStarted: () => {},
        noteTurnInput: () => {},
        ensureInput: () => {},
      }) as never,
    activityPublisher: {} as never,
    currentActivityLaunch: () => undefined,
    activity: () => ({}) as never,
    sync: { noticePrefix: () => "" },
    runningMentionIdentity: () => undefined,
    contexts: {
      onNewContext: () => () => {},
      noteMemoryActivity: () => {},
    } as never,
    reconcileIdleTurn: () => false,
    startAgent: async () => ({}) as never,
    assertRunning: () => {},
    agentIdForContext: () => "agent-1",
  });

  composed.messageAttention.bindConversation("agent-1", "#general", "conv-1");
  composed.messageAttention.recordHistoryRead("agent-1", {
    spelling: "#general",
    target: "#general",
    shown: [12],
    through: 12,
  });
  expect(applyCalls).toBe(1);
  expect(writeCalls).toBe(0);
});

test("codeAgentProviderCapabilities matches createCodeAgentProvider across every RuntimeProvider", () => {
  for (const provider of Object.values(RUNTIME_PROVIDER) as RuntimeProvider[]) {
    const instance = createCodeAgentProvider(provider);
    const caps = codeAgentProviderCapabilities(provider);
    expect(caps).toEqual({
      reportsCompaction: instance.reportsCompaction === true,
      supportsSessionSummaryRecycle: instance.supportsSessionSummaryRecycle === true,
      hasNativeSessionResumeFacts: instance.readSessionResumeFacts !== undefined,
      ...(instance.idleRecycleMinColdGapMs !== undefined
        ? { idleRecycleMinColdGapMs: instance.idleRecycleMinColdGapMs }
        : {}),
    });
  }
});

test("ColdIdleSweep uses providerCapabilities without constructing CodeAgentProvider for summary-only or unsupported providers", async () => {
  let providerConstructCalls = 0;
  let stopped = 0;
  const now = 10_000_000_000;

  const sweep = new ColdIdleSweep({
    agentIds: () => ["agent-opencode", "agent-cursor"],
    agent: (agentId) =>
      agentId === "agent-opencode"
        ? {
            agentId,
            provider: RUNTIME_PROVIDER.OPENCODE,
            sessionId: "sess-1",
            lastEventAtMs: now - 3_600_000,
            lastContextTokens: 200_000,
            busyReason: undefined,
            envVars: {
              COFORGE_WAKE_RECYCLE_MIN_COLD_GAP_MS: "60000",
              COFORGE_WAKE_RECYCLE_MIN_CONTEXT_TOKENS: "10000",
            },
          }
        : {
            agentId,
            provider: RUNTIME_PROVIDER.CURSOR,
            sessionId: "sess-2",
            lastEventAtMs: now - 3_600_000,
            lastContextTokens: 200_000,
            busyReason: undefined,
          },
    provider: () => {
      providerConstructCalls += 1;
      throw new Error("should not construct provider when providerCapabilities suffices");
    },
    providerCapabilities: codeAgentProviderCapabilities,
    readSummaryFacts: () => ({
      lastActivityAtMs: now - 3_600_000,
      lastContextTokens: 200_000,
    }),
    stop: async () => {
      stopped += 1;
    },
    now: () => now,
  });

  sweep.notifyIdle("agent-cursor");
  sweep.notifyIdle("agent-opencode");
  await sweep.sweep();

  expect(providerConstructCalls).toBe(0);
  expect(stopped).toBe(1);
});

test("composeMessages settles tracked mentions even when history read occurs before conversationId is bound", async () => {
  const acked: string[] = [];
  let applyCalls = 0;

  const composed = composeMessages({
    sweeps: { add: () => {} },
    connection: { workspaceId: "ws-1", computerId: "comp-1" },
    stateDirectory: "/tmp/coforge-r6-test-unused",
    transport: () =>
      ({
        sendAgentMentionDeliveryTransition: async () => {},
        sendAgentDeliveryAck: async (ack: { deliveryId: string }) => {
          acked.push(ack.deliveryId);
        },
      }) as never,
    consumedSeqs: {
      read: () => ({ targets: {}, aliases: {} }),
      write: () => {},
      apply: () => {
        applyCalls += 1;
      },
    } as never,
    deliveryGate: {
      pending: () => [],
      enqueue: () => {},
      busy: () => {},
      isBusy: () => true,
      hasQueued: () => false,
      shouldHold: () => false,
      explicitHold: () => undefined,
    } as never,
    runtimeRelease: {
      isRecovering: () => false,
    } as never,
    processManager: {
      session: () => ({
        hasLiveTurn: true,
        notify: async () => {},
      }),
    } as never,
    launchCustody: () =>
      ({
        noteTurnStarted: () => {},
        noteTurnInput: () => {},
        ensureInput: () => {},
      }) as never,
    activityPublisher: {} as never,
    currentActivityLaunch: () => undefined,
    activity: () => ({}) as never,
    sync: { noticePrefix: () => "" },
    runningMentionIdentity: () => ({ launchId: "l1", sessionId: "s1" }),
    contexts: {
      onNewContext: () => () => {},
      noteMemoryActivity: () => {},
    } as never,
    reconcileIdleTurn: () => false,
    startAgent: async () => ({}) as never,
    assertRunning: () => {},
    agentIdForContext: () => "agent-1",
  });

  await composed.mentionDeliveries.deliver({
    workspaceId: "ws-1",
    agentId: "agent-1",
    conversationId: "conv-1",
    deliveryId: "del-1",
    messageId: "msg-1",
    requestId: "req-1",
    sequence: 5,
    target: "#general",
    body: "@agent hi",
    mentions: [],
    createdAtMs: 1_000,
    reason: "mention",
    mentionDelivery: {
      messageId: "msg-1",
      launchId: "l1",
      sessionId: "s1",
      computerId: "comp-1",
    },
  } as never);

  composed.messageAttention.clearAgent("agent-1");
  composed.messageAttention.recordHistoryRead("agent-1", {
    spelling: "#general",
    target: "#general",
    shown: [5],
    through: 5,
  });

  await Promise.resolve();
  expect(acked).toEqual(["del-1"]);
  expect(applyCalls).toBe(1);
});

test("ColdIdleSweep fallback path constructs provider once per readFacts and respects custom provider overrides", async () => {
  let providerConstructCalls = 0;
  let stopped = 0;
  const now = 10_000_000_000;

  const sweep = new ColdIdleSweep({
    agentIds: () => ["agent-custom"],
    agent: () => ({
      agentId: "agent-custom",
      provider: RUNTIME_PROVIDER.CODEX,
      sessionId: "sess-1",
      lastEventAtMs: now - 40 * 60_000,
      lastContextTokens: 200_000,
      busyReason: undefined,
    }),
    provider: () => {
      providerConstructCalls += 1;
      return {
        provider: RUNTIME_PROVIDER.CODEX,
        idleRecycleMinColdGapMs: 30 * 60_000,
        readSessionResumeFacts: async () => ({
          lastActivityAtMs: now - 40 * 60_000,
          lastContextTokens: 200_000,
        }),
      } as never;
    },
    providerCapabilities: () => undefined,
    stop: async () => {
      stopped += 1;
    },
    now: () => now,
  });

  await sweep.sweep();

  expect(stopped).toBe(1);
  expect(providerConstructCalls).toBe(2);
});
