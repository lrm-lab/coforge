import { expect, test } from "bun:test";
import {
  formatSettledTime,
  settlementErrorKind,
} from "#src/features/artifacts/use-artifact-settlement";
import {
  decodeArtifactSettlementChangedEvent,
  decodeArtifactVersionPublishedEvent,
} from "#src/features/artifacts/artifact-realtime";
import { AppError } from "#src/lib/app-error";
import {
  conversationRealtimeChannel,
  workspaceConversationChannel,
} from "#src/features/conversations/conversation-realtime";
import {
  announceSettlementChange,
  type ArtifactSignalEvent,
} from "#src/server/artifacts/artifact-signals.server";

const WORKSPACE_ID = "019b0381-1111-7111-8111-111111111111";
const CONVERSATION_ID = "019b0381-2222-7222-8222-222222222222";
const ARTIFACT_ID = "019b0381-3333-7333-8333-333333333333";

const event = {
  type: "artifact.version.published.v1",
  workspaceId: WORKSPACE_ID,
  artifactId: ARTIFACT_ID,
  number: 3,
} as const;

const settlementEvent = {
  type: "artifact.settlement.changed.v1",
  workspaceId: WORKSPACE_ID,
  artifactId: ARTIFACT_ID,
} as const;

test("a page reads a version announcement, and nothing else as one", () => {
  expect(decodeArtifactVersionPublishedEvent(event)).toEqual(event);
  expect(
    decodeArtifactVersionPublishedEvent(new TextEncoder().encode(JSON.stringify(event))),
  ).toEqual(event);
  expect(
    decodeArtifactVersionPublishedEvent({ ...event, type: "task.changed.v1" }),
  ).toBeUndefined();
  expect(decodeArtifactVersionPublishedEvent({ ...event, number: 0 })).toBeUndefined();
  expect(
    decodeArtifactVersionPublishedEvent({ ...event, publisher: { agentId: "agent-1" } }),
  ).toEqual(event);
});

test("a page reads a settlement change announcement, and nothing else as one", () => {
  expect(decodeArtifactSettlementChangedEvent(settlementEvent)).toEqual(settlementEvent);
  expect(
    decodeArtifactSettlementChangedEvent(new TextEncoder().encode(JSON.stringify(settlementEvent))),
  ).toEqual(settlementEvent);
  expect(
    decodeArtifactSettlementChangedEvent({
      ...settlementEvent,
      type: "artifact.access.changed.v1",
    }),
  ).toBeUndefined();
  expect(
    decodeArtifactSettlementChangedEvent({ ...settlementEvent, artifactId: "" }),
  ).toBeUndefined();
});

test("announceSettlementChange publishes to the home channel and widens for workspace artifacts", async () => {
  const sent: Array<{ channel: string; event: ArtifactSignalEvent }> = [];
  const signals = {
    publish: async (channel: string, payload: ArtifactSignalEvent) => {
      sent.push({ channel, event: payload });
    },
  };
  await announceSettlementChange(signals, {
    workspaceId: WORKSPACE_ID,
    homeKey: `conversation:${CONVERSATION_ID}`,
    wide: false,
    artifactId: ARTIFACT_ID,
  });
  await announceSettlementChange(signals, {
    workspaceId: WORKSPACE_ID,
    homeKey: `conversation:${CONVERSATION_ID}`,
    wide: true,
    artifactId: ARTIFACT_ID,
  });
  expect(sent).toEqual([
    { channel: conversationRealtimeChannel(CONVERSATION_ID), event: settlementEvent },
    { channel: conversationRealtimeChannel(CONVERSATION_ID), event: settlementEvent },
    { channel: workspaceConversationChannel(WORKSPACE_ID), event: settlementEvent },
  ]);
});

test("settlementErrorKind separates permission denials from generic failures", () => {
  expect(settlementErrorKind(new AppError("ACCESS_DENIED"))).toBe("forbidden");
  expect(settlementErrorKind(new AppError("NOT_FOUND"))).toBe("failed");
  expect(settlementErrorKind(new AppError("INTERNAL_ERROR"))).toBe("failed");
  expect(settlementErrorKind(new Error("boom"))).toBe("failed");
  expect(settlementErrorKind(null)).toBe("failed");
});

test("formatSettledTime formats absolute short month/day/time and guards invalid timestamps", () => {
  const iso = "2026-11-27T14:05:00.000Z";
  expect(formatSettledTime(iso, { locale: "en", timeZone: "UTC", timeFormat: "24h" })).toContain(
    "Nov 27",
  );
  expect(formatSettledTime(iso, { locale: "en", timeZone: "UTC", timeFormat: "24h" })).toContain(
    "14:05",
  );
  expect(formatSettledTime(iso, { locale: "zh-CN", timeZone: "UTC", timeFormat: "24h" })).toContain(
    "14:05",
  );
  expect(formatSettledTime("not-a-date", { locale: "en", timeZone: "UTC" })).toBe("not-a-date");
});
