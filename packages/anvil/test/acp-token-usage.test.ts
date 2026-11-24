import { expect, test } from "bun:test";
import { RequestError } from "@agentclientprotocol/sdk/unstable";
import { acpPromptTokenUsage } from "#src/acp-context-usage";
import { AGENT_RUNTIME_EVENT_TYPE } from "#src/contract";
import { grokNativeTurn, grokPromptNotificationTokenUsage } from "#src/grok/session";
import { openTestAcpSession } from "./fixtures/acp-session-harness";

test("acpPromptTokenUsage handles exclusive inputTokens, separate thoughtTokens, and snake_case", () => {
  expect(
    acpPromptTokenUsage({
      stopReason: "end_turn",
      usage: {
        totalTokens: 10_400,
        inputTokens: 1_000,
        cachedReadTokens: 8_000,
        cachedWriteTokens: 500,
        outputTokens: 500,
        thoughtTokens: 400,
      },
    }),
  ).toEqual({
    uncachedInputTokens: 1_000,
    cacheReadTokens: 8_000,
    cacheWriteTokens: 500,
    outputTokens: 900,
    reasoningOutputTokens: 400,
  });

  expect(
    acpPromptTokenUsage({
      stopReason: "end_turn",
      usage: {
        inputTokens: 1_000,
        outputTokens: 0,
        thoughtTokens: 300,
      },
    }),
  ).toEqual({
    uncachedInputTokens: 1_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 300,
    reasoningOutputTokens: 300,
  });

  expect(
    acpPromptTokenUsage({
      usage: {
        input_tokens: 2_000,
        cache_read_input_tokens: 1_500,
        cache_creation_input_tokens: 200,
        output_tokens: 400,
        reasoning_tokens: 120,
      },
    }),
  ).toEqual({
    uncachedInputTokens: 300,
    cacheReadTokens: 1_500,
    cacheWriteTokens: 200,
    outputTokens: 400,
    reasoningOutputTokens: 120,
  });
});

test("AcpSession emits TOKEN_USAGE on failed and interrupted prompt settlements", async () => {
  const harness = await openTestAcpSession();
  try {
    const failedAdmission = harness.session.notify("hit-max");
    const failedPrompt = await harness.nextRequest("session/prompt");
    failedPrompt.resolve({
      stopReason: "max_tokens",
      usage: { inputTokens: 1_200, outputTokens: 800, totalTokens: 2_000 },
    });
    await failedAdmission;

    const failedTokenIndex = harness.events.findIndex(
      (event) => event.type === AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
    );
    const failedCompletedIndex = harness.events.findIndex((event) => event.type === "completed");
    expect(failedTokenIndex).toBeGreaterThanOrEqual(0);
    expect(failedCompletedIndex).toBeGreaterThan(failedTokenIndex);
    expect(harness.events[failedTokenIndex]).toEqual({
      type: AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
      usage: {
        uncachedInputTokens: 1_200,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 800,
      },
    });
    expect(harness.events[failedCompletedIndex]).toEqual({ type: "completed", status: "failed" });

    harness.events.length = 0;
    const cancelledAdmission = harness.session.notify("cancel-me");
    const cancelledPrompt = await harness.nextRequest("session/prompt");
    cancelledPrompt.resolve({
      stopReason: "cancelled",
      usage: { inputTokens: 500, cachedReadTokens: 300, outputTokens: 50, totalTokens: 550 },
    });
    await cancelledAdmission.catch(() => undefined);

    const cancelledTokenIndex = harness.events.findIndex(
      (event) => event.type === AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
    );
    const cancelledCompletedIndex = harness.events.findIndex((event) => event.type === "completed");
    expect(cancelledTokenIndex).toBeGreaterThanOrEqual(0);
    expect(cancelledCompletedIndex).toBeGreaterThan(cancelledTokenIndex);
    expect(harness.events[cancelledTokenIndex]).toEqual({
      type: AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
      usage: {
        uncachedInputTokens: 200,
        cacheReadTokens: 300,
        cacheWriteTokens: 0,
        outputTokens: 50,
      },
    });
    expect(harness.events[cancelledCompletedIndex]).toEqual({
      type: "completed",
      status: "interrupted",
    });
  } finally {
    await harness.session.dispose();
  }
});

test("AcpSession emits TOKEN_USAGE from steered session/prompt responses before completed", async () => {
  const harness = await openTestAcpSession({
    steer: {
      unboundedRequest: true,
      settlesTurn: true,
      request: (text, sessionId) => ({
        method: "session/prompt",
        params: { sessionId, prompt: [{ type: "text", text }] },
      }),
      accepted: (response) => {
        const stopReason = (response as { stopReason?: string })?.stopReason;
        return { accepted: stopReason !== undefined && stopReason !== "cancelled" };
      },
    },
  });
  try {
    const firstAdmission = harness.session.notify("first");
    const firstPrompt = await harness.nextRequest("session/prompt");
    harness.update({ sessionUpdate: "text", text: "working" });
    await firstAdmission;

    const steerAdmission = harness.session.notify("steer");
    const steerPrompt = await harness.nextRequest("session/prompt");
    const completed = Promise.withResolvers<void>();
    const unsubscribe = harness.session.subscribe((event) => {
      if (event.type === "completed") completed.resolve();
    });
    firstPrompt.resolve({ stopReason: "end_turn" });
    steerPrompt.resolve({
      stopReason: "end_turn",
      usage: {
        inputTokens: 4_000,
        cachedReadTokens: 3_000,
        outputTokens: 600,
        totalTokens: 4_600,
      },
    });
    await steerAdmission;
    await completed.promise;
    unsubscribe();

    const tokenEvents = harness.events.filter(
      (event) => event.type === AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
    );
    expect(tokenEvents).toEqual([
      {
        type: AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
        usage: {
          uncachedInputTokens: 1_000,
          cacheReadTokens: 3_000,
          cacheWriteTokens: 0,
          outputTokens: 600,
        },
      },
    ]);
    const tokenIndex = harness.events.findIndex(
      (event) => event.type === AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
    );
    const completedIndex = harness.events.findIndex((event) => event.type === "completed");
    expect(completedIndex).toBeGreaterThan(tokenIndex);
  } finally {
    await harness.session.dispose();
  }
});

test("AcpSession emits TOKEN_USAGE from native Grok turns with eventId dedup and replay skip", async () => {
  const seenEventIds = new Set<string>();
  const harness = await openTestAcpSession({
    promptMeta: (turnId) => ({ promptId: turnId }),
    steer: {
      request: (text, sessionId) => ({ method: "_x.ai/interject", params: { sessionId, text } }),
      accepted: () => ({ accepted: true }),
      nativeTurn: (method, params, ownPromptId) =>
        grokNativeTurn(method, params, ownPromptId, seenEventIds),
    },
  });
  try {
    harness.notification("_x.ai/queue/changed", {
      sessionId: "s1",
      runningPromptId: "interject-fallback-1",
    });
    harness.notification("_x.ai/session_notification", {
      sessionId: "s1",
      _meta: { eventId: "evt-replay", isReplay: true },
      update: {
        sessionUpdate: "turn_completed",
        prompt_id: "interject-fallback-1",
        stop_reason: "end_turn",
        usage: { input_tokens: 999, output_tokens: 999 },
      },
    });
    expect(
      harness.events.filter((event) => event.type === AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE),
    ).toEqual([]);
    expect(harness.session.hasLiveTurn).toBe(true);

    const completionParams = {
      sessionId: "s1",
      _meta: { eventId: "evt-1" },
      update: {
        sessionUpdate: "turn_completed",
        prompt_id: "interject-fallback-1",
        stop_reason: "end_turn",
        usage: {
          input_tokens: 3_000,
          cached_read_tokens: 2_000,
          output_tokens: 450,
          thought_tokens: 100,
        },
      },
    };
    harness.notification("_x.ai/session_notification", completionParams);
    harness.notification("_x.ai/session_notification", completionParams);

    const tokenEvents = harness.events.filter(
      (event) => event.type === AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
    );
    expect(tokenEvents).toEqual([
      {
        type: AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
        usage: {
          uncachedInputTokens: 1_000,
          cacheReadTokens: 2_000,
          cacheWriteTokens: 0,
          outputTokens: 450,
          reasoningOutputTokens: 100,
        },
      },
    ]);
    const tokenIndex = harness.events.findIndex(
      (event) => event.type === AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
    );
    const completedIndex = harness.events.findIndex((event) => event.type === "completed");
    expect(completedIndex).toBeGreaterThan(tokenIndex);
  } finally {
    await harness.session.dispose();
  }
});

test("AcpSession captures trailing usage_update with token fields right after prompt settlement", async () => {
  const harness = await openTestAcpSession({
    trailingUsageWaitMs: 80,
  });
  try {
    const admission = harness.session.notify("hello");
    const prompt = await harness.nextRequest("session/prompt");
    prompt.resolve({ stopReason: "end_turn" });
    await admission;

    setTimeout(() => {
      harness.update({
        sessionUpdate: "usage_update",
        used: 12_000,
        size: 200_000,
        usage: {
          inputTokens: 11_000,
          cachedReadTokens: 9_000,
          outputTokens: 1_000,
          totalTokens: 12_000,
        },
      });
    }, 10);

    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline && !harness.events.some((event) => event.type === "completed"))
      await Bun.sleep(5);

    const tokenIndex = harness.events.findIndex(
      (event) => event.type === AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
    );
    const completedIndex = harness.events.findIndex((event) => event.type === "completed");
    expect(tokenIndex).toBeGreaterThanOrEqual(0);
    expect(completedIndex).toBeGreaterThan(tokenIndex);
    expect(harness.events[tokenIndex]).toEqual({
      type: AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
      usage: {
        uncachedInputTokens: 2_000,
        cacheReadTokens: 9_000,
        cacheWriteTokens: 0,
        outputTokens: 1_000,
      },
    });
  } finally {
    await harness.session.dispose();
  }
});

test("AcpSession captures usage carried on RequestError data without losing failed turn tokens", async () => {
  const harness = await openTestAcpSession();
  try {
    const admission = harness.session.notify("rpc-fail");
    const prompt = await harness.nextRequest("session/prompt");
    harness.promptWritten();
    prompt.reject(
      new RequestError(-32603, "Internal error", {
        detail: "stream failed",
        usage: { inputTokens: 800, outputTokens: 120, totalTokens: 920 },
      }),
    );
    await admission;

    const tokenEvents = harness.events.filter(
      (event) => event.type === AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
    );
    expect(tokenEvents).toEqual([
      {
        type: AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
        usage: {
          uncachedInputTokens: 800,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 120,
        },
      },
    ]);
  } finally {
    await harness.session.dispose();
  }
});

test("AcpSession uses Grok turn_completed usage on failed prompt and avoids double-counting when prompt reply also has usage", async () => {
  const seenEventIds = new Set<string>();
  const harness = await openTestAcpSession({
    promptMeta: (turnId) => ({ promptId: turnId }),
    promptNotificationTokenUsage: (method, params, promptId) =>
      grokPromptNotificationTokenUsage(method, params, promptId, seenEventIds),
  });
  try {
    const failedAdmission = harness.session.notify("fail-with-notification-usage");
    const failedPrompt = await harness.nextRequest("session/prompt");
    harness.promptWritten();
    const failedPromptId = (failedPrompt.params as { _meta: { promptId: string } })._meta.promptId;
    harness.notification("_x.ai/session_notification", {
      sessionId: "s1",
      _meta: { eventId: "evt-fail-1" },
      update: {
        sessionUpdate: "turn_completed",
        prompt_id: failedPromptId,
        stop_reason: "error",
        usage: { input_tokens: 700, output_tokens: 90 },
      },
    });
    failedPrompt.reject(new RequestError(-32603, "Internal error", "upstream error"));
    await failedAdmission;

    expect(
      harness.events.filter((event) => event.type === AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE),
    ).toEqual([
      {
        type: AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
        usage: {
          uncachedInputTokens: 700,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 90,
        },
      },
    ]);

    harness.events.length = 0;
    const okAdmission = harness.session.notify("both-carry-usage");
    const okPrompt = await harness.nextRequest("session/prompt");
    const okPromptId = (okPrompt.params as { _meta: { promptId: string } })._meta.promptId;
    harness.notification("_x.ai/session_notification", {
      sessionId: "s1",
      _meta: { eventId: "evt-ok-1" },
      update: {
        sessionUpdate: "turn_completed",
        prompt_id: okPromptId,
        stop_reason: "end_turn",
        usage: { input_tokens: 1_000, output_tokens: 200 },
      },
    });
    okPrompt.resolve({
      stopReason: "end_turn",
      usage: { inputTokens: 1_000, outputTokens: 200, totalTokens: 1_200 },
    });
    await okAdmission;

    expect(
      harness.events.filter((event) => event.type === AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE),
    ).toHaveLength(1);
  } finally {
    await harness.session.dispose();
  }
});

test("AcpSession captures post-settlement usage_update tokens once and never fabricates from context-only updates", async () => {
  const harness = await openTestAcpSession();
  try {
    const firstAdmission = harness.session.notify("no-reply-usage");
    const firstPrompt = await harness.nextRequest("session/prompt");
    firstPrompt.resolve({ stopReason: "end_turn" });
    await firstAdmission;

    harness.update({ sessionUpdate: "usage_update", used: 5_000, size: 200_000 });
    expect(
      harness.events.filter((event) => event.type === AGENT_RUNTIME_EVENT_TYPE.CONTEXT_USAGE),
    ).toEqual([
      { type: AGENT_RUNTIME_EVENT_TYPE.CONTEXT_USAGE, usedTokens: 5_000, windowTokens: 200_000 },
    ]);
    expect(
      harness.events.filter((event) => event.type === AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE),
    ).toEqual([]);

    harness.update({
      sessionUpdate: "usage_update",
      used: 5_400,
      size: 200_000,
      usage: { inputTokens: 5_000, outputTokens: 400, totalTokens: 5_400 },
    });
    expect(
      harness.events.filter((event) => event.type === AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE),
    ).toEqual([
      {
        type: AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
        usage: {
          uncachedInputTokens: 5_000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 400,
        },
      },
    ]);

    harness.events.length = 0;
    const secondAdmission = harness.session.notify("has-reply-usage");
    const secondPrompt = await harness.nextRequest("session/prompt");
    secondPrompt.resolve({
      stopReason: "end_turn",
      usage: { inputTokens: 2_000, outputTokens: 300, totalTokens: 2_300 },
    });
    await secondAdmission;
    harness.update({
      sessionUpdate: "usage_update",
      used: 7_700,
      size: 200_000,
      usage: { inputTokens: 2_000, outputTokens: 300, totalTokens: 2_300 },
    });
    expect(
      harness.events.filter((event) => event.type === AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE),
    ).toHaveLength(1);
  } finally {
    await harness.session.dispose();
  }
});

test("AcpSession emits TOKEN_USAGE before error when an error listener synchronously disposes the session", async () => {
  const rpcHarness = await openTestAcpSession();
  try {
    rpcHarness.session.subscribe((event) => {
      if (event.type === "error") void rpcHarness.session.dispose();
    });
    const admission = rpcHarness.session.notify("fatal-rpc-error");
    const prompt = await rpcHarness.nextRequest("session/prompt");
    rpcHarness.promptWritten();
    prompt.reject(
      new RequestError(-32603, "Quota exceeded", {
        usage: { inputTokens: 900, outputTokens: 110, totalTokens: 1_010 },
      }),
    );
    await admission;

    const tokenEvents = rpcHarness.events.filter(
      (event) => event.type === AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
    );
    const tokenIndex = rpcHarness.events.findIndex(
      (event) => event.type === AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
    );
    const errorIndex = rpcHarness.events.findIndex((event) => event.type === "error");
    expect(tokenEvents).toEqual([
      {
        type: AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
        usage: {
          uncachedInputTokens: 900,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 110,
        },
      },
    ]);
    expect(tokenIndex).toBeGreaterThanOrEqual(0);
    expect(errorIndex).toBeGreaterThan(tokenIndex);
  } finally {
    await rpcHarness.session.dispose();
  }

  const stopHarness = await openTestAcpSession();
  try {
    stopHarness.session.subscribe((event) => {
      if (event.type === "error") void stopHarness.session.dispose();
    });
    const admission = stopHarness.session.notify("fatal-stop-reason");
    const prompt = await stopHarness.nextRequest("session/prompt");
    prompt.resolve({
      stopReason: "refusal",
      usage: { inputTokens: 600, cachedReadTokens: 200, outputTokens: 40, totalTokens: 640 },
    });
    await admission;

    const tokenEvents = stopHarness.events.filter(
      (event) => event.type === AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
    );
    const tokenIndex = stopHarness.events.findIndex(
      (event) => event.type === AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
    );
    const errorIndex = stopHarness.events.findIndex((event) => event.type === "error");
    expect(tokenEvents).toEqual([
      {
        type: AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
        usage: {
          uncachedInputTokens: 400,
          cacheReadTokens: 200,
          cacheWriteTokens: 0,
          outputTokens: 40,
        },
      },
    ]);
    expect(tokenIndex).toBeGreaterThanOrEqual(0);
    expect(errorIndex).toBeGreaterThan(tokenIndex);
  } finally {
    await stopHarness.session.dispose();
  }
});
