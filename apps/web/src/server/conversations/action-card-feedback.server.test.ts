import { describe, expect, it } from "bun:test";
import { decodeAgentMessageDelivery } from "@lrm/coforge-sdk/internal";

import { AppError } from "#src/lib/app-error";
import type { SubmitUserFeedbackInput } from "#src/server/feedback/feedback.server";
import {
  commitFeedbackSubmitCard,
  feedbackSubmitActionCardView,
  resolveFeedbackSubmitPayload,
} from "./action-card-feedback.server";
import { ActionCards } from "./action-cards.server";

function baseView() {
  return {
    messageId: "msg-1",
    state: "pending" as const,
    canCommit: false,
    canCancel: false,
  };
}

function createCardDb(options?: {
  state?: string;
  kind?: string;
  ownerId?: string;
  updateCount?: number;
  wakeError?: Error;
}) {
  const calls: string[] = [];
  let updatedArgs: Record<string, unknown> | undefined;
  let deliveryData: Record<string, unknown> | undefined;
  const card = {
    messageId: "msg-1",
    conversationId: "conv-1",
    workspaceId: "ws-1",
    kind: options?.kind ?? "feedback:submit",
    payload: {
      type: "feedback:submit",
      category: "bug",
      body: "Original drafted feedback",
    },
    preparedByAgentId: "agent-1",
    state: options?.state ?? "pending",
    committedByUserId: null,
    preparedByAgent: { ownerId: options?.ownerId ?? "owner-1" },
  };
  const db = {
    actionCard: {
      findUnique: async () => card,
      updateMany: async (args: Record<string, unknown>) => {
        calls.push("actionCard.updateMany");
        updatedArgs = args;
        return { count: options?.updateCount ?? 1 };
      },
    },
    conversation: {
      findFirst: async () => ({
        id: "conv-1",
        workspaceId: "ws-1",
        directKey: null,
        channelName: "general",
        visibility: "public",
        archivedAt: null,
        members: [{ id: "m-1", userId: "user-2", leftAt: null }],
      }),
      findUnique: async () => ({
        id: "conv-1",
        workspaceId: "ws-1",
        directKey: null,
        channelName: "general",
        visibility: "public",
        archivedAt: null,
      }),
    },
    conversationMember: {
      findFirst: async () => ({ id: "m-1", userId: "user-2", leftAt: null }),
    },
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    user: {
      findUnique: async () => ({ username: "alice" }),
    },
    message: {
      findUnique: async () => ({
        id: "msg-1",
        workspaceId: "ws-1",
        sequence: 7,
        threadRootId: null,
        conversation: {
          id: "conv-1",
          channelName: "general",
          directKey: null,
          kind: null,
          task: null,
        },
      }),
    },
    agent: {
      findUnique: async () => ({ computerId: "comp-1" }),
    },
    agentMessageDelivery: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.push("agentMessageDelivery.create");
        if (options?.wakeError) throw options.wakeError;
        deliveryData = data;
        return {
          deliveryId: "del-1",
          createdAt: new Date("2026-11-26T10:00:00.000Z"),
          reason: data.reason,
        };
      },
    },
  } as never;

  return {
    db,
    calls,
    getUpdatedArgs: () => updatedArgs,
    getDeliveryData: () => deliveryData,
  };
}

describe("action-card-feedback.server", () => {
  it("resolves payload and builds browser view with commit and cancel permissions while pending", () => {
    const payload = resolveFeedbackSubmitPayload({
      type: "feedback:submit",
      category: "idea",
      body: "Add keyboard shortcut",
    });
    expect(payload).toEqual({
      type: "feedback:submit",
      category: "idea",
      body: "Add keyboard shortcut",
    });

    const pendingView = feedbackSubmitActionCardView(baseView(), { result: null }, payload, true);
    expect(pendingView).toMatchObject({
      kind: "feedback:submit",
      category: "idea",
      body: "Add keyboard shortcut",
      canCommit: true,
      canCancel: true,
    });

    const executedView = feedbackSubmitActionCardView(
      { ...baseView(), state: "executed" },
      { result: { feedbackId: "fb-9", category: "bug", body: "Edited feedback body" } },
      payload,
      false,
    );
    expect(executedView).toMatchObject({
      kind: "feedback:submit",
      canCommit: false,
      canCancel: false,
      result: { feedbackId: "fb-9", category: "bug", body: "Edited feedback body" },
    });
  });

  it("submits user-edited feedback under human identity first, marks executed, publishes realtime, and wakes agent", async () => {
    const harness = createCardDb();
    const submittedInputs: SubmitUserFeedbackInput[] = [];
    const realtimeUpdates: { conversationId: string; messageId: string; sequence: number }[] = [];
    const published: { data: Uint8Array }[] = [];

    const result = await commitFeedbackSubmitCard(
      harness.db,
      {
        messageAvailable: async (payload: {
          conversationId: string;
          messageId: string;
          sequence: number;
        }) => {
          harness.calls.push("realtime.messageAvailable");
          realtimeUpdates.push({
            conversationId: payload.conversationId,
            messageId: payload.messageId,
            sequence: payload.sequence,
          });
        },
        messagePublished: async () => {},
        typing: async () => {},
        messageRead: async () => {},
      } as never,
      { workspaceId: "ws-1", actorUserId: "user-2" },
      {
        messageId: "msg-1",
        category: "idea",
        body: "  Edited by human before sending  ",
        pagePath: "/w/core/channel/conv-1",
        clientInfo: "Web · macOS",
      },
      {
        submitFeedback: async (_db, input) => {
          harness.calls.push("submitUserFeedback");
          submittedInputs.push(input);
          return { id: "fb-42", createdAt: "2026-11-26T10:00:00.000Z" };
        },
        publisher: {
          publishBatch: async (items: readonly { data: Uint8Array }[]) => {
            harness.calls.push("publisher.publishBatch");
            published.push(...items);
            return new Map(items.map((_item, index) => [String(index), { status: "sent" }]));
          },
        } as never,
      },
    );

    expect(result).toEqual({
      feedbackId: "fb-42",
      category: "idea",
      body: "Edited by human before sending",
    });
    expect(submittedInputs).toEqual([
      {
        userId: "user-2",
        workspaceId: "ws-1",
        category: "idea",
        body: "Edited by human before sending",
        pagePath: "/w/core/channel/conv-1",
        clientInfo: "Web · macOS",
        files: [],
      },
    ]);
    expect(harness.calls).toEqual([
      "submitUserFeedback",
      "actionCard.updateMany",
      "realtime.messageAvailable",
      "agentMessageDelivery.create",
      "publisher.publishBatch",
    ]);
    expect(harness.getUpdatedArgs()).toMatchObject({
      where: { messageId: "msg-1", state: "pending" },
      data: {
        state: "executed",
        committedByUserId: "user-2",
        result: { feedbackId: "fb-42", category: "idea", body: "Edited by human before sending" },
      },
    });
    expect(realtimeUpdates).toEqual([
      { conversationId: "conv-1", messageId: "msg-1", sequence: 7 },
    ]);
    expect(harness.getDeliveryData()).toMatchObject({
      workspaceId: "ws-1",
      conversationId: "conv-1",
      agentId: "agent-1",
      messageId: "msg-1",
      sequence: 7,
      reason: "choice",
    });
    expect(published).toHaveLength(1);
    const decoded = decodeAgentMessageDelivery(published[0]!.data);
    expect(decoded.reason).toBe("choice");
    expect(decoded.body).toBe(
      "@alice completed your action card in #general: submitted idea feedback (fb-42).",
    );
  });

  it("falls back to pre-filled payload values when user submits without edits", async () => {
    const harness = createCardDb();
    let captured: SubmitUserFeedbackInput | undefined;
    const result = await commitFeedbackSubmitCard(
      harness.db,
      undefined,
      { workspaceId: "ws-1", actorUserId: "user-2" },
      { messageId: "msg-1" },
      {
        submitFeedback: async (_db, input) => {
          captured = input;
          return { id: "fb-1", createdAt: "2026-11-26T10:00:00.000Z" };
        },
        publisher: {
          publishBatch: async () => new Map(),
        } as never,
      },
    );

    expect(result).toEqual({
      feedbackId: "fb-1",
      category: "bug",
      body: "Original drafted feedback",
    });
    expect(captured?.category).toBe("bug");
    expect(captured?.body).toBe("Original drafted feedback");
  });

  it("rejects blank or over-long edited body without calling submitUserFeedback", async () => {
    const harness = createCardDb();
    let called = false;
    const submitFeedback = async () => {
      called = true;
      return { id: "fb-x", createdAt: "2026-11-26T10:00:00.000Z" };
    };

    await expect(
      commitFeedbackSubmitCard(
        harness.db,
        undefined,
        { workspaceId: "ws-1", actorUserId: "user-2" },
        { messageId: "msg-1", body: "   " },
        { submitFeedback },
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    await expect(
      commitFeedbackSubmitCard(
        harness.db,
        undefined,
        { workspaceId: "ws-1", actorUserId: "user-2" },
        { messageId: "msg-1", body: "a".repeat(2001) },
        { submitFeedback },
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    expect(called).toBe(false);
  });

  it("returns CONFLICT when conditional update loses a race, and still succeeds if wake fails", async () => {
    const lostRace = createCardDb({ updateCount: 0 });
    await expect(
      commitFeedbackSubmitCard(
        lostRace.db,
        undefined,
        { workspaceId: "ws-1", actorUserId: "user-2" },
        { messageId: "msg-1" },
        {
          submitFeedback: async () => ({ id: "fb-race", createdAt: "2026-11-26T10:00:00.000Z" }),
        },
      ),
    ).rejects.toBeInstanceOf(AppError);

    const wakeFails = createCardDb({ wakeError: new Error("centrifugo down") });
    const result = await commitFeedbackSubmitCard(
      wakeFails.db,
      undefined,
      { workspaceId: "ws-1", actorUserId: "user-2" },
      { messageId: "msg-1" },
      {
        submitFeedback: async () => ({ id: "fb-ok", createdAt: "2026-11-26T10:00:00.000Z" }),
        publisher: { publishBatch: async () => new Map() } as never,
      },
    );
    expect(result).toEqual({
      feedbackId: "fb-ok",
      category: "bug",
      body: "Original drafted feedback",
    });
  });

  it("allows any authorized member to cancel a pending feedback:submit card", async () => {
    const harness = createCardDb({ ownerId: "other-owner" });
    await new ActionCards(harness.db).cancel(
      { workspaceId: "ws-1", actorUserId: "user-2" },
      "msg-1",
    );
    expect(harness.getUpdatedArgs()).toMatchObject({
      where: { messageId: "msg-1", state: "pending" },
      data: { state: "cancelled", committedByUserId: "user-2" },
    });
  });
});
