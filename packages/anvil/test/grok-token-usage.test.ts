import { expect, test } from "bun:test";
import type { AgentRuntimeEvent, AgentSessionOptions } from "@coforge/agent";
import type { AcpConnection } from "#src/acp/connection";
import type { AcpSessionSink, AcpTurnReader } from "#src/acp/profile";
import { AcpSession } from "#src/acp/session";
import { AGENT_RUNTIME_EVENT_TYPE } from "#src/contract";
import { GrokEventDedup, grokNotificationEventId } from "#src/grok/connection";
import { grokNativeTurn } from "#src/grok/session";

const EMPTY_TURN: AcpTurnReader = {
  read: () => [],
  end: () => [],
};

test("GrokEventDedup deduplicates _meta and top-level eventId fields at ingress and passes queue changes through", () => {
  const dedup = new GrokEventDedup();
  expect(
    grokNotificationEventId("_x.ai/queue/changed", { _meta: { eventId: "q-1" } }),
  ).toBeUndefined();
  expect(dedup.accept("_x.ai/queue/changed", { _meta: { eventId: "q-1" } })).toBe(true);
  expect(dedup.accept("_x.ai/queue/changed", { _meta: { eventId: "q-1" } })).toBe(true);

  const variants: Record<string, unknown>[] = [
    { _meta: { eventId: "e-1" } },
    { _meta: { event_id: "e-2" } },
    { update: { _meta: { eventId: "e-3" } } },
    { update: { _meta: { event_id: "e-4" } } },
    { eventId: "e-5" },
    { event_id: "e-6" },
    { update: { eventId: "e-7" } },
    { update: { event_id: "e-8" } },
  ];
  for (const params of variants) {
    expect(dedup.accept("_x.ai/session_notification", params)).toBe(true);
    expect(dedup.accept("_x.ai/session_notification", params)).toBe(false);
  }
});

test("AcpSession with pure grokNativeTurn replays opening frames with eventId without sticking hasLiveTurn and emits TOKEN_USAGE once for live native turns", async () => {
  let sink: AcpSessionSink | undefined;
  const dedup = new GrokEventDedup();
  const deliver = (method: string, params: Record<string, unknown>) => {
    if (!dedup.accept(method, params)) return;
    sink!.notification(method, params);
  };
  const connection = {
    process: { onFailure: () => () => {}, onClose: () => () => {} },
    initialize: async () => ({ protocolVersion: 1 }),
    dispose: async () => {},
    connection: {
      agent: {
        request: async () => ({ stopReason: "end_turn" }),
        notify: async () => {},
      },
    },
  } as unknown as AcpConnection;

  const events: AgentRuntimeEvent[] = [];
  const session = new AcpSession(
    {
      label: "Grok",
      openTransport: (value) => {
        sink = value;
        return connection;
      },
      openSession: async () => {
        deliver("_x.ai/queue/changed", { sessionId: "s1", runningPromptId: "background-early" });
        deliver("_x.ai/session_notification", {
          sessionId: "s1",
          _meta: { eventId: "evt-early-1" },
          update: {
            sessionUpdate: "turn_completed",
            prompt_id: "background-early",
            stop_reason: "end_turn",
            usage: { input_tokens: 100, output_tokens: 20 },
          },
        });
        deliver("_x.ai/queue/changed", { sessionId: "s1", runningPromptId: "background-live" });
        return { sessionId: "s1", resumable: true };
      },
      turn: () => EMPTY_TURN,
      steer: {
        request: (text, sessionId) => ({ method: "_x.ai/interject", params: { sessionId, text } }),
        accepted: () => ({ accepted: true }),
        nativeTurn: (method, params, ownPromptId) => grokNativeTurn(method, params, ownPromptId),
      },
    },
    { agentWorkspaceDirectory: "/tmp", instructions: "" } satisfies AgentSessionOptions,
    1_000,
    (work) => work,
  );
  session.subscribe((event) => events.push(event));
  try {
    await session.open();
    expect(session.hasLiveTurn).toBe(true);

    const completion = {
      sessionId: "s1",
      _meta: { eventId: "evt-live-1" },
      update: {
        sessionUpdate: "turn_completed",
        prompt_id: "background-live",
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 20 },
      },
    };
    deliver("_x.ai/session_notification", completion);
    deliver("_x.ai/session_notification", completion);

    expect(session.hasLiveTurn).toBe(false);
    expect(events.filter((e) => e.type === AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE)).toEqual([
      {
        type: AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
        usage: {
          uncachedInputTokens: 100,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 20,
        },
      },
    ]);
    expect(events.filter((e) => e.type === "completed")).toEqual([
      { type: "completed", status: "completed" },
    ]);
  } finally {
    await session.dispose();
  }
});
