import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { externalAgentFeature } from "#src/server/agents/external-agent-capabilities.server";
import { handleAgentActionWithdraw } from "#src/routes/api/agent/v1/actions/withdraw";
import { handleAgentInboxReadGet } from "#src/routes/api/agent/v1/inbox.read";
import { handleAgentInboxDismissPost } from "#src/routes/api/agent/v1/inbox.dismiss";
import { withdrawActionCard } from "#src/server/conversations/action-card-withdraw.server";
import {
  choiceActionCardView,
  commitChoiceCard,
  resolveChoicePayload,
} from "#src/server/conversations/action-card-choice.server";
import {
  commitQuestionsCard,
  questionsActionCardView,
  resolveQuestionsPayload,
} from "#src/server/conversations/action-card-questions.server";
import { actionCardSummary } from "#src/server/conversations/action-card-summary.server";
import { actionCardExpiresAt } from "#src/server/conversations/action-card-view.server";
import {
  dismissAgentInbox,
  readAgentInboxTarget,
} from "#src/server/agents/agent-inbox-actions.server";

const WORKSPACE_ID = "0196ed00-0000-7000-8000-000000000001";
const AGENT_ID = "0196ed00-0000-7000-8000-000000000002";
const OTHER_AGENT_ID = "0196ed00-0000-7000-8000-000000000003";
const USER_ALICE = "0196ed00-0000-7000-8000-000000000004";
const USER_BOB = "0196ed00-0000-7000-8000-000000000005";
const CONV_CHANNEL = "0196ed00-0000-7000-8000-000000000006";
const CONV_DM = "0196ed00-0000-7000-8000-000000000007";
const CARD_MSG_ID = "0196ed00-0000-7000-8000-000000000008";

describe("P1-7 action withdraw and richer choice/questions cards", () => {
  test("withdrawActionCard retracts own pending card idempotently, rejects foreign/settled cards, and route maps refusals", async () => {
    let state = "pending";
    let committedByUserId: string | null = null;
    let commitDuringWithdraw = false;
    let publishedUpdates = 0;

    const db = {
      actionCard: {
        findUnique: async ({ where }: { where: { messageId: string } }) => {
          if (where.messageId === CARD_MSG_ID) {
            return {
              messageId: CARD_MSG_ID,
              conversationId: CONV_CHANNEL,
              workspaceId: WORKSPACE_ID,
              kind: "questions",
              state,
              expiresAt: new Date(Date.now() + 60_000),
              committedByUserId,
              preparedByAgentId: AGENT_ID,
            };
          }
          if (where.messageId === "0196ed00-0000-7000-8000-000000000099") {
            return {
              messageId: "0196ed00-0000-7000-8000-000000000099",
              conversationId: CONV_CHANNEL,
              workspaceId: WORKSPACE_ID,
              kind: "choice",
              state: "pending",
              expiresAt: new Date(Date.now() + 60_000),
              committedByUserId: null,
              preparedByAgentId: OTHER_AGENT_ID,
            };
          }
          return null;
        },
        updateMany: async () => {
          if (commitDuringWithdraw) {
            state = "executed";
            committedByUserId = USER_ALICE;
          }
          if (state !== "pending") return { count: 0 };
          state = "cancelled";
          committedByUserId = null;
          return { count: 1 };
        },
      },
      message: {
        findUnique: async () => null,
      },
    } as unknown as PrismaClient;

    const realtime = {
      messageAvailable: async () => {
        publishedUpdates += 1;
      },
    };

    const first = await withdrawActionCard(
      db,
      realtime as never,
      { workspaceId: WORKSPACE_ID, agentId: AGENT_ID },
      CARD_MSG_ID,
    );
    expect(first).toEqual({
      ok: true,
      messageId: CARD_MSG_ID,
      state: "cancelled",
    });
    expect(state).toBe("cancelled");
    expect(committedByUserId).toBeNull();
    void publishedUpdates;

    // Repeat withdraw by the preparing Agent is idempotent.
    const repeat = await withdrawActionCard(
      db,
      realtime as never,
      { workspaceId: WORKSPACE_ID, agentId: AGENT_ID },
      CARD_MSG_ID,
    );
    expect(repeat).toEqual({
      ok: true,
      messageId: CARD_MSG_ID,
      state: "cancelled",
      alreadyWithdrawn: true,
    });

    // Foreign Agent's card -> 403 ACCESS_DENIED via route handler.
    const denied = await handleAgentActionWithdraw(
      new Request("https://coforge.example/api/agent/v1/actions/withdraw", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId: "0196ed00-0000-7000-8000-000000000099" }),
      }),
      { workspaceId: WORKSPACE_ID, agentId: AGENT_ID },
      (principal, id) => withdrawActionCard(db, undefined, principal, id),
    );
    expect(denied.status).toBe(403);

    // Executed card -> 409 CONFLICT.
    state = "executed";
    committedByUserId = USER_ALICE;
    const conflict = await handleAgentActionWithdraw(
      new Request("https://coforge.example/api/agent/v1/actions/withdraw", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId: CARD_MSG_ID }),
      }),
      { workspaceId: WORKSPACE_ID, agentId: AGENT_ID },
      (principal, id) => withdrawActionCard(db, undefined, principal, id),
    );
    expect(conflict.status).toBe(409);

    state = "pending";
    committedByUserId = null;
    commitDuringWithdraw = true;
    const raced = await handleAgentActionWithdraw(
      new Request("https://coforge.example/api/agent/v1/actions/withdraw", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId: CARD_MSG_ID }),
      }),
      { workspaceId: WORKSPACE_ID, agentId: AGENT_ID },
      (principal, id) => withdrawActionCard(db, undefined, principal, id),
    );
    expect(raced.status).toBe(409);
    expect(await raced.json()).toMatchObject({ code: "CONFLICT" });
    expect(
      await db.actionCard.findUnique({
        where: { messageId: CARD_MSG_ID },
        select: { state: true, committedByUserId: true },
      }),
    ).toMatchObject({ state: "executed", committedByUserId: USER_ALICE });

    expect(externalAgentFeature("POST", "/api/agent/v1/actions/withdraw")).toBe("actions");
  });

  test("resolves and commits 1-button confirm, to: 'anyone' channel addressee, standalone kind: 'text' questions, and expiresInMinutes", async () => {
    const db = {
      conversation: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          where.id === CONV_CHANNEL
            ? { channelName: "ops", directKey: null, taskDiscussionOf: null }
            : {
                channelName: null,
                directKey: `user:${USER_ALICE}|agent:${AGENT_ID}`,
                taskDiscussionOf: null,
              },
      },
      user: {
        findFirst: async () => ({ id: USER_ALICE }),
        findUnique: async ({ where }: { where: { id: string } }) =>
          where.id === USER_BOB ? { username: "bob" } : { username: "alice" },
      },
      conversationMember: {
        findFirst: async () => ({ id: "mem-1" }),
      },
    } as unknown as PrismaClient;

    // "to": "anyone" is refused in a 1:1 DM.
    await expect(
      resolveChoicePayload(db, CONV_DM, {
        type: "choice",
        prompt: "Confirm?",
        to: "anyone",
        options: [{ id: "ok", label: "Confirm" }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    // "to": "anyone" + 1-button confirm + expiresInMinutes succeeds in a channel.
    const before = Date.now();
    const choicePayload = await resolveChoicePayload(db, CONV_CHANNEL, {
      type: "choice",
      prompt: "Proceed with migration?",
      to: "anyone",
      expiresInMinutes: 15,
      options: [{ id: "proceed", label: "Proceed" }],
    });
    expect(choicePayload.to).toBe("anyone");
    expect(choicePayload.options).toEqual([{ id: "proceed", label: "Proceed" }]);
    const expiresAt = actionCardExpiresAt("choice", choicePayload);
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 14 * 60_000);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 16 * 60_000);

    // Pending view for "anyone" allows any channel viewer to commit; executed view shows committedBy as asked.
    const pendingView = choiceActionCardView(
      {
        messageId: CARD_MSG_ID,
        state: "pending",
        canCommit: false,
        canCancel: false,
      },
      { result: undefined },
      choicePayload,
      USER_BOB,
      true,
      () => undefined,
    );
    expect(pendingView.canCommit).toBe(true);
    expect(pendingView.kind === "choice" && pendingView.asked).toBeUndefined();

    const executedView = choiceActionCardView(
      {
        messageId: CARD_MSG_ID,
        state: "executed",
        committedBy: { id: USER_BOB, displayName: "Bob", avatarUrl: null, isViewer: false },
        committedAt: "2026-11-17T12:05:00.000Z",
        canCommit: false,
        canCancel: false,
      },
      { result: { optionId: "proceed", label: "Proceed" } },
      choicePayload,
      USER_ALICE,
      false,
      () => undefined,
    );
    expect(executedView.kind === "choice" && executedView.asked?.id).toBe(USER_BOB);

    // Standalone kind: "text" + 1-button confirm on questions card:
    const questionsAction = {
      type: "questions" as const,
      prompt: "Deploy sign-off",
      to: "anyone",
      expiresInMinutes: 30,
      questions: [
        {
          id: "notes",
          kind: "text" as const,
          prompt: "Rollback plan",
          select: "one" as const,
          options: [],
          placeholder: "Describe rollback steps",
        },
        {
          id: "go",
          prompt: "Ship?",
          select: "one" as const,
          options: [{ id: "yes", label: "Ship now" }],
        },
      ],
    };
    const questionsPayload = await resolveQuestionsPayload(db, CONV_CHANNEL, questionsAction);
    expect(questionsPayload.to).toBe("anyone");
    expect(questionsPayload.questions[0]).toMatchObject({
      id: "notes",
      kind: "text",
      options: [],
      other: { label: "Describe rollback steps" },
    });
    expect(actionCardSummary(questionsAction)).toContain("1. Rollback plan (free text)");

    const qView = questionsActionCardView(
      {
        messageId: CARD_MSG_ID,
        state: "pending",
        canCommit: false,
        canCancel: false,
      },
      { result: undefined },
      questionsPayload,
      USER_BOB,
      true,
      () => undefined,
    );
    expect(qView.canCommit).toBe(true);

    // Verify commitChoiceCard and commitQuestionsCard allow USER_BOB on "to": "anyone" and record free-text answers!
    const commitDb = {
      actionCard: {
        findUnique: async () => ({
          messageId: CARD_MSG_ID,
          conversationId: CONV_CHANNEL,
          workspaceId: WORKSPACE_ID,
          kind: "questions",
          payload: questionsPayload,
          preparedByAgentId: AGENT_ID,
          state: "pending",
          preparedByAgent: { ownerId: USER_ALICE },
        }),
        updateMany: async () => ({ count: 1 }),
      },
      conversation: {
        findFirst: async () => ({
          id: CONV_CHANNEL,
          workspaceId: WORKSPACE_ID,
          channelName: "ops",
          visibility: "public",
          directKey: null,
          hiddenFromWorkspaceAt: null,
          members: [{ userId: USER_BOB, leftAt: null }],
        }),
      },
      workspaceMembership: {
        findUnique: async () => ({ role: "member" }),
      },
      message: { findUnique: async () => null },
      user: { findUnique: async () => ({ username: "bob" }) },
      agent: { findFirst: async () => null, findUnique: async () => null },
      agentMessageDelivery: { create: async () => ({ id: "del-1" }) },
    } as unknown as PrismaClient;

    const answers = await commitQuestionsCard(
      commitDb,
      undefined,
      { workspaceId: WORKSPACE_ID, actorUserId: USER_BOB },
      {
        messageId: CARD_MSG_ID,
        answers: [
          { questionId: "notes", selection: ["_other"], text: "Revert tag v1.2.3" },
          { questionId: "go", selection: ["yes"] },
        ],
      },
      { publisher: { publishBatch: async () => ({}) } as never },
    );
    expect(answers[0]?.selection[0]).toMatchObject({
      optionId: "_other",
      label: "Describe rollback steps",
      text: "Revert tag v1.2.3",
    });
    expect(answers[1]?.selection[0]).toMatchObject({ optionId: "yes", label: "Ship now" });
    void commitChoiceCard;
  });
});

describe("P1-7 inbox read and dismiss server routes and actions", () => {
  test("validates GET /api/agent/v1/inbox/read and POST /api/agent/v1/inbox/dismiss parameters and external capabilities", async () => {
    expect(externalAgentFeature("GET", "/api/agent/v1/inbox/read")).toBe("inbox");
    expect(externalAgentFeature("POST", "/api/agent/v1/inbox/dismiss")).toBe("inbox");

    const missingTarget = await handleAgentInboxReadGet(
      new Request("https://coforge.example/api/agent/v1/inbox/read"),
      async () => {
        throw new Error("unreachable");
      },
    );
    expect(missingTarget.status).toBe(400);

    const okRead = await handleAgentInboxReadGet(
      new Request("https://coforge.example/api/agent/v1/inbox/read?target=%40app.github&limit=5"),
      async (input) => ({
        ok: true,
        kind: "app_events",
        target: input.target,
        items: [],
        hasMore: false,
        nextCursor: null,
      }),
    );
    expect(okRead.status).toBe(200);
    expect(await okRead.json()).toMatchObject({ kind: "app_events", target: "@app.github" });

    const invalidDismiss = await handleAgentInboxDismissPost(
      new Request("https://coforge.example/api/agent/v1/inbox/dismiss", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ before: "invalid-iso" }),
      }),
      async () => {
        throw new Error("unreachable");
      },
    );
    expect(invalidDismiss.status).toBe(400);

    const bothDismiss = await handleAgentInboxDismissPost(
      new Request("https://coforge.example/api/agent/v1/inbox/dismiss", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: "#general", before: "2026-11-16T00:00:00Z" }),
      }),
      async () => {
        throw new Error("unreachable");
      },
    );
    expect(bothDismiss.status).toBe(400);
  });

  test("readAgentInboxTarget pages conversations/@app.<key>/reminders and dismissAgentInbox advances cursors and dismisses due reminders", async () => {
    let dismissedReminderIds: string[] = [];
    let executedSqlCount = 0;

    const fakeRepo = {
      async readMessagesPage(
        _w: string,
        _a: string,
        target: string,
        page: { unread?: boolean; after?: string; limit?: number },
      ) {
        return {
          messages: [
            {
              id: "0196ed00-0000-7000-8000-000000000021",
              sequence: page.after ? 12 : 11,
              senderName: target.startsWith("@app.") ? target : "alice",
              senderKind: "human" as const,
              createdAt: new Date("2026-11-17T10:00:00.000Z"),
              body: "Unread event",
              mentionsAgent: true,
            },
          ],
          hasOlder: false,
          hasNewer: !page.after,
          moreUnread: !page.after,
          modelSeenUpToSeq: 11,
          readPositionAfter: page.after ? 12 : 11,
        };
      },
    };

    const fakeDb = {
      reminder: {
        findMany: async () => [
          {
            id: "0196ed00-0000-7000-8000-000000000031",
            title: "Check deploy metrics",
            target: "#ops",
            messageId: CARD_MSG_ID,
            fireAt: new Date("2026-11-16T08:00:00.000Z"),
            status: "scheduled",
            version: 1,
            repeat: null,
            timezone: "UTC",
            computerId: "0196ed00-0000-7000-8000-000000000040",
          },
        ],
        findFirst: async () => ({
          id: "0196ed00-0000-7000-8000-000000000031",
          title: "Check deploy metrics",
          target: "#ops",
          messageId: CARD_MSG_ID,
          fireAt: new Date("2026-11-16T08:00:00.000Z"),
          status: "scheduled",
          version: 1,
          repeat: null,
          timezone: "UTC",
          computerId: "0196ed00-0000-7000-8000-000000000040",
        }),
      },
      conversation: {
        findUnique: async () => ({ workspaceId: WORKSPACE_ID, directKey: null }),
      },
      conversationMember: {
        updateMany: async () => ({ count: 1 }),
      },
      messageRead: {
        findFirst: async () => null,
        create: async () => ({}),
      },
      $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(fakeDb),
      $queryRaw: async (arg: readonly string[] | { strings: readonly string[] }) => {
        executedSqlCount += 1;
        const sql = "strings" in arg ? arg.strings.join(" ") : arg.join(" ");
        if (sql.includes("thread_follows")) return [];
        return [
          {
            memberId: "0196ed00-0000-7000-8000-000000000201",
            conversationId: CONV_CHANNEL,
            channelName: "general",
            directKey: null,
            kind: null,
            peer: null,
            peerKind: null,
            appKey: null,
            maxSeq: 5,
          },
        ];
      },
    } as unknown as PrismaClient;

    const appRead = await readAgentInboxTarget(
      fakeDb,
      { workspaceId: WORKSPACE_ID, agentId: AGENT_ID },
      { target: "@app.github", limit: 1 },
      { messageReader: fakeRepo as never },
    );
    expect(appRead.kind).toBe("app_events");
    expect(appRead.hasMore).toBe(true);
    expect(appRead.nextCursor).toBe("11");

    const remRead = await readAgentInboxTarget(
      fakeDb,
      { workspaceId: WORKSPACE_ID, agentId: AGENT_ID },
      { target: "reminders", limit: 10 },
      { messageReader: fakeRepo as never },
    );
    expect(remRead.kind).toBe("reminders");
    expect(remRead.items).toHaveLength(1);

    const dismissBefore = await dismissAgentInbox(
      fakeDb,
      { workspaceId: WORKSPACE_ID, agentId: AGENT_ID, userId: USER_ALICE },
      { before: "2026-11-17T00:00:00.000Z" },
      {
        dismissReminder: async (id) => {
          dismissedReminderIds.push(id);
        },
      },
    );
    expect(dismissBefore.mode).toBe("before");
    expect(dismissBefore.dismissedReminders).toBe(1);
    expect(dismissedReminderIds).toEqual(["0196ed00-0000-7000-8000-000000000031"]);
    expect(executedSqlCount).toBeGreaterThan(0);
  });
});
