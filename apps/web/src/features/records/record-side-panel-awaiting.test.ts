import { expect, test } from "bun:test";

import {
  AWAITING_FALLBACK_POLL_MS,
  awaitingAssistantPollIntervalMs,
} from "./record-side-panel-awaiting";

test("disables 4s fallback polling when realtime is connected and conversation id is known", () => {
  expect(
    awaitingAssistantPollIntervalMs({
      realtimeConnected: true,
      assistantConversationId: "conv-1",
    }),
  ).toBeNull();
});

test("enables 4s fallback polling when realtime is disconnected or conversation id is missing", () => {
  expect(
    awaitingAssistantPollIntervalMs({
      realtimeConnected: false,
      assistantConversationId: "conv-1",
    }),
  ).toBe(AWAITING_FALLBACK_POLL_MS);
  expect(
    awaitingAssistantPollIntervalMs({
      realtimeConnected: true,
      assistantConversationId: null,
    }),
  ).toBe(AWAITING_FALLBACK_POLL_MS);
  expect(
    awaitingAssistantPollIntervalMs({
      realtimeConnected: true,
      assistantConversationId: "",
    }),
  ).toBe(AWAITING_FALLBACK_POLL_MS);
});
