import { expect, test } from "bun:test";

import type {
  ForwardMessageResult,
  ForwardTarget,
  ForwardedMessageView,
} from "#src/features/conversations/message-forward";
import {
  isRetryableForwardFailure,
  canForwardMessage,
  canSelectTarget,
  forwardOutcomeView,
  forwardSourceTarget,
  forwardTargetKey,
  forwardTargetLabel,
} from "#src/features/conversations/message-forward-model";

const channel: ForwardTarget = {
  kind: "channel",
  conversationId: "11111111-1111-4111-8111-111111111111",
  name: "design",
  joined: true,
  canSend: true,
};
const forwarded: ForwardedMessageView = {
  sourceSenderName: "Ada",
  sourceCreatedAt: "2026-10-28T16:54:00.000Z",
  sourceBody: "hello",
  sourceConversation: { id: "channel-id", name: "design" },
  sourceMessageId: "message-id",
  sourceAccessible: true,
};

test("only a person's or an Agent's own plain message can be forwarded", () => {
  expect(canForwardMessage({ senderKind: "user" })).toBe(true);
  expect(canForwardMessage({ senderKind: "agent" })).toBe(true);
  expect(canForwardMessage({ senderKind: "system" })).toBe(false);
  expect(canForwardMessage({ senderKind: "user", forwarded })).toBe(false);
  expect(canForwardMessage({ senderKind: "agent", actionCard: {} as never })).toBe(false);
});

test("targets are keyed and labelled by what they are", () => {
  expect(forwardTargetKey(channel)).toBe(
    `channel:${channel.kind === "channel" && channel.conversationId}`,
  );
  expect(forwardTargetLabel(channel)).toBe("#design");
  const person: ForwardTarget = {
    kind: "person",
    userId: "u1",
    name: "Frank",
    avatarUrl: null,
    joined: true,
    canSend: true,
  };
  expect(forwardTargetKey(person)).toBe("person:u1");
  expect(forwardTargetLabel(person)).toBe("@Frank");
});

test("a disabled target is not selectable, nor an eleventh", () => {
  expect(canSelectTarget({ ...channel, canSend: false } as ForwardTarget, 0, false)).toBe(false);
  expect(canSelectTarget(channel, 10, false)).toBe(false);
  expect(canSelectTarget(channel, 10, true)).toBe(true);
});

test("the source link opens the thread for a reply and goes to the conversation's kind", () => {
  expect(forwardSourceTarget("acme", forwarded)).toEqual({
    to: "/w/$workspaceSlug/channel/$channelId",
    params: { workspaceSlug: "acme", channelId: "channel-id" },
    search: { message: "message-id" },
  });
  expect(
    forwardSourceTarget("acme", {
      ...forwarded,
      sourceConversation: { id: "dm-id", name: null },
      sourceThreadRootId: "root-id",
    }),
  ).toEqual({
    to: "/w/$workspaceSlug/dm/$dmId",
    params: { workspaceSlug: "acme", dmId: "dm-id" },
    search: { message: "root-id", threadRootId: "root-id" },
  });
  expect(forwardSourceTarget("acme", { ...forwarded, sourceMessageId: undefined })).toBeUndefined();
});

test("a result closes the dialog only when every destination took it", () => {
  const ok = (destination: string) => ({
    destination,
    status: "success" as const,
    message: { id: "m", sequence: 1 },
  });
  const bad = (destination: string) => ({
    destination,
    status: "failed" as const,
    error: { code: "not_joined" as const },
  });
  const view = (results: ForwardMessageResult["results"]) =>
    forwardOutcomeView({ outcome: "partial_failure", results });
  expect(view([ok("a"), ok("b")]).kind).toBe("done");
  expect(view([ok("a"), bad("b")])).toMatchObject({ kind: "partial", delivered: 1, total: 2 });
  const none = view([bad("a")]);
  expect(none.kind).toBe("none");
  expect(none.kind === "none" && none.failed.get("a")).toBe("not_joined");
});

test("Try Again is offered only for a refusal another attempt may get past", () => {
  expect(isRetryableForwardFailure("failed")).toBe(true);
  expect(isRetryableForwardFailure("not_joined")).toBe(true);
  expect(isRetryableForwardFailure("archived")).toBe(false);
  expect(isRetryableForwardFailure("read_only")).toBe(false);
  expect(isRetryableForwardFailure("no_access")).toBe(false);
});
