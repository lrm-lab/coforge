import { expect, test } from "bun:test";
import {
  decodeArtifactSettlementChangedEvent,
  decodeArtifactVersionPublishedEvent,
} from "#src/features/artifacts/artifact-realtime";
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
