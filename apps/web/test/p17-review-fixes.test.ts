import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { handleAgentInboxDismissPost } from "#src/routes/api/agent/v1/inbox.dismiss";
import {
  dismissAgentInbox,
  readAgentInboxTarget,
} from "#src/server/agents/agent-inbox-actions.server";
import { ActionCards } from "#src/server/conversations/action-cards.server";
import { resolveChoicePayload } from "#src/server/conversations/action-card-choice.server";
import { expireActionCards } from "#src/server/conversations/action-card-expiry.server";
import { resolveQuestionsPayload } from "#src/server/conversations/action-card-questions.server";
import { actionCardViews } from "#src/server/conversations/action-card-views.server";
import { ReminderRefusal } from "#src/server/reminders/reminders.server";

const uid = (n: number) => `0196ed00-0000-7000-8000-${String(n).padStart(12, "0")}`;
const WORKSPACE_ID = uid(1);
const AGENT_ID = uid(2);
const USER_ALICE = uid(4);
const USER_BOB = uid(5);
const CONV_CHANNEL = uid(6);
const CONV_APP = uid(16);
const CONV_ATTACHMENT = uid(17);
const CARD_MSG_ID = uid(8);
const COMP_ID = uid(40);
const mkRem = (id: string, status: string, fireAt: string, repeat: string | null, version = 1) => ({
  id,
  title: `Rem ${id.slice(-3)}`,
  target: "#ops",
  messageId: CARD_MSG_ID,
  fireAt: new Date(fireAt),
  status,
  version,
  repeat,
  timezone: "UTC",
  computerId: COMP_ID,
});

describe("P1-7 review fixes (#44 & #47)", () => {
  test("Issue 1: inbox.dismiss maps ReminderRefusal status codes and dismisses due reminders with ReminderSync while preserving future scheduled rows", async () => {
    for (const [code, expected] of [
      ["ACCESS_DENIED", 403],
      ["NOT_FOUND", 404],
      ["CONFLICT", 409],
      ["TEMPORARILY_UNAVAILABLE", 503],
      ["INVALID_INPUT", 400],
    ] as const) {
      const res = await handleAgentInboxDismissPost(
        new Request("https://coforge.example/api/agent/v1/inbox/dismiss", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ target: "reminders" }),
        }),
        async () => {
          throw new ReminderRefusal(code, `refused: ${code}`);
        },
      );
      expect(res.status).toBe(expected);
    }

    const reminders = [
      mkRem(uid(101), "scheduled", "2026-11-16T08:00:00.000Z", null, 1),
      mkRem(uid(102), "scheduled", "2026-11-16T09:00:00.000Z", "every:1h", 3),
      mkRem(uid(103), "fired", "2026-11-16T07:00:00.000Z", null, 1),
    ];
    const events: Array<{ reminderId: string; type: string; scheduledFor: Date }> = [
      { reminderId: uid(103), type: "fired", scheduledFor: new Date("2026-11-16T07:00:00.000Z") },
    ];

    const txClient = {
      reminder: {
        findFirst: async ({ where }: { where: { id: string } }) => {
          const r = reminders.find((entry) => entry.id === where.id);
          return r ? { ...r } : null;
        },
        findMany: async () =>
          reminders
            .filter(
              (r) =>
                r.status === "scheduled" ||
                (r.status === "fired" &&
                  !events.some(
                    (e) =>
                      e.reminderId === r.id &&
                      (e.type === "acknowledged" || e.type === "dismissed") &&
                      e.scheduledFor.getTime() >= r.fireAt.getTime(),
                  )),
            )
            .map((r) => ({ ...r })),
        update: async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { status?: string; fireAt?: Date };
        }) => {
          const found = reminders.find((r) => r.id === where.id)!;
          if (data.status) found.status = data.status;
          if (data.fireAt) found.fireAt = data.fireAt;
          found.version += 1;
          return found;
        },
        updateMany: async ({
          where,
          data,
        }: {
          where: { id: { in: string[] } };
          data: { status?: string; firedAt?: Date };
        }) => {
          let count = 0;
          for (const r of reminders) {
            if (!where.id.in.includes(r.id)) continue;
            if (data.status) r.status = data.status;
            r.version += 1;
            count += 1;
          }
          return { count };
        },
      },
      reminderOccurrence: {
        findMany: async () => [],
        updateMany: async () => ({ count: 0 }),
      },
      reminderEvent: {
        createMany: async ({
          data,
        }: {
          data: Array<{ reminderId: string; type: string; scheduledFor: Date }>;
        }) => {
          events.push(...data);
          return { count: data.length };
        },
      },
    };
    const db = {
      ...txClient,
      $queryRaw: async () => [],
      $transaction: async <T>(fn: (tx: typeof txClient) => Promise<T>) => fn(txClient),
    } as unknown as PrismaClient;

    const syncMessages: Array<{ operation: string; reminderId?: string; jobs: unknown[] }> = [];
    const first = await dismissAgentInbox(
      db,
      { workspaceId: WORKSPACE_ID, agentId: AGENT_ID, userId: USER_ALICE },
      { target: "reminders" },
      {
        publishReminderSync: async (sync) => {
          syncMessages.push(sync);
        },
      },
    );
    expect(first.dismissedReminders).toBe(3);
    expect(syncMessages.map((s) => s.operation).sort()).toEqual(["cancel", "upsert"]);

    const futureRescheduled = reminders.find((r) => r.id === uid(102))!;
    const savedFireAt = futureRescheduled.fireAt;
    const savedVersion = futureRescheduled.version;
    const futureTargetDismiss = await dismissAgentInbox(
      db,
      { workspaceId: WORKSPACE_ID, agentId: AGENT_ID, userId: USER_ALICE },
      { target: `reminder:${uid(102)}` },
    );
    expect(futureTargetDismiss.dismissedReminders).toBe(0);
    expect(futureRescheduled.status).toBe("scheduled");
    expect(futureRescheduled.fireAt).toEqual(savedFireAt);
    expect(futureRescheduled.version).toBe(savedVersion);

    const second = await dismissAgentInbox(
      db,
      { workspaceId: WORKSPACE_ID, agentId: AGENT_ID, userId: USER_ALICE },
      { target: "reminders" },
    );
    expect(second.dismissedReminders).toBe(0);

    reminders.push(mkRem(uid(104), "fired", "2026-11-18T07:00:00.000Z", null, 1));
    const beforeOld = await dismissAgentInbox(
      db,
      { workspaceId: WORKSPACE_ID, agentId: AGENT_ID, userId: USER_ALICE },
      { before: "2026-11-10T00:00:00.000Z" },
    );
    expect(beforeOld.dismissedReminders).toBe(0);
  });

  test("Issue 2: expireActionCards handles to: 'anyone' without querying User.id = 'anyone' and wakes the preparing Agent", async () => {
    let userLookupIds: string[] = [];
    let createdDeliveries = 0;
    const db = {
      $queryRaw: async () => [
        {
          messageId: CARD_MSG_ID,
          conversationId: CONV_CHANNEL,
          workspaceId: WORKSPACE_ID,
          kind: "choice",
          preparedByAgentId: AGENT_ID,
          payload: {
            type: "choice",
            prompt: "Who can deploy?",
            to: "anyone",
            options: [{ id: "me", label: "I can" }],
          },
        },
      ],
      user: {
        findUnique: async ({ where }: { where: { id: string } }) => {
          userLookupIds.push(where.id);
          throw new Error(`Invalid UUID queried on User.id: ${where.id}`);
        },
      },
      message: {
        findUnique: async () => ({
          sequence: 5,
          threadRootId: null,
          workspaceId: WORKSPACE_ID,
          conversation: {
            id: CONV_CHANNEL,
            channelName: "ops",
            directKey: null,
            kind: null,
            taskDiscussionOf: null,
            members: [],
          },
        }),
      },
      agent: {
        findUnique: async () => ({ computerId: "0196ed00-0000-7000-8000-000000000040" }),
      },
      agentMessageDelivery: {
        create: async () => {
          createdDeliveries += 1;
          return { deliveryId: "0196ed00-0000-7000-8000-000000000090" };
        },
      },
    } as unknown as PrismaClient;

    const count = await expireActionCards(db, new Date());
    expect(count).toBe(1);
    expect(userLookupIds).toEqual([]);
    expect(createdDeliveries).toBe(1);
  });

  test("Issue 3 & 4: reminder keyset cursor (fireAt, id) never skips out-of-order UUIDs, and message inbox read preserves unread: true + scanned cursor", async () => {
    const allReminders = [
      {
        ...mkRem(uid(99), "scheduled", "2026-11-18T01:00:00.000Z", null),
        events: [] as Array<{ scheduledFor: Date }>,
      },
      {
        ...mkRem(uid(50), "fired", "2026-11-18T01:30:00.000Z", "every:1h", 2),
        events: [{ scheduledFor: new Date("2026-11-18T01:30:00.000Z") }],
      },
      {
        ...mkRem(uid(10), "scheduled", "2026-11-18T02:00:00.000Z", null),
        events: [] as Array<{ scheduledFor: Date }>,
      },
    ];
    let capturedWhere: unknown;
    const remDb = {
      reminder: {
        findMany: async ({ where, take }: { where: Record<string, unknown>; take: number }) => {
          capturedWhere = where;
          const orClause = where.OR as
            | [{ fireAt: { gt: Date } }, { fireAt: Date; id: { gt: string } }]
            | undefined;
          const filtered = orClause
            ? allReminders.filter(
                (r) =>
                  r.fireAt.getTime() > orClause[0].fireAt.gt.getTime() ||
                  (r.fireAt.getTime() === orClause[1].fireAt.getTime() && r.id > orClause[1].id.gt),
              )
            : allReminders;
          return filtered.slice(0, take);
        },
      },
    } as unknown as PrismaClient;

    const p1 = await readAgentInboxTarget(
      remDb,
      { workspaceId: WORKSPACE_ID, agentId: AGENT_ID },
      { target: "reminders", limit: 1 },
    );
    expect(p1.items[0]).toMatchObject({ id: "0196ed00-0000-7000-8000-000000000099" });
    expect(p1.hasMore).toBe(true);
    expect(p1.nextCursor).toBeTruthy();

    const p2 = await readAgentInboxTarget(
      remDb,
      { workspaceId: WORKSPACE_ID, agentId: AGENT_ID },
      { target: "reminders", limit: 1, cursor: p1.nextCursor! },
    );
    expect(capturedWhere).toBeDefined();
    expect(p2.items[0]).toMatchObject({ id: "0196ed00-0000-7000-8000-000000000010" });

    // Issue 4: Message page 1 with 0 peer items (all own/system messages) but hasNewer=true & readPositionAfter=25
    const pageCalls: Array<Record<string, unknown>> = [];
    const msgReader = {
      async readMessagesPage(_w: string, _a: string, _t: string, page: Record<string, unknown>) {
        pageCalls.push(page);
        if (!page.after) {
          return {
            messages: [],
            hasOlder: false,
            hasNewer: true,
            moreUnread: true,
            modelSeenUpToSeq: 25,
            readPositionAfter: 25,
          };
        }
        return {
          messages: [
            {
              id: "0196ed00-0000-7000-8000-000000000050",
              sequence: 26,
              senderHandle: "alice",
              createdAt: new Date("2026-11-18T02:00:00.000Z"),
              body: "Peer message after own run",
            },
          ],
          hasOlder: true,
          hasNewer: false,
          moreUnread: false,
          modelSeenUpToSeq: 26,
          readPositionAfter: 26,
        };
      },
    };
    const msgResult = await readAgentInboxTarget(
      remDb,
      { workspaceId: WORKSPACE_ID, agentId: AGENT_ID },
      { target: "#general", limit: 5, cursor: "25" },
      { messageReader: msgReader as never },
    );
    expect(pageCalls[0]).toEqual({ unread: true, after: "25", limit: 5 });
    expect(msgResult.items).toHaveLength(1);

    // Also verify when bounded scan stops with empty items and hasMore=true, nextCursor uses readPositionAfter!
    const emptyScanReader = {
      async readMessagesPage(_w: string, _a: string, _t: string, page: Record<string, unknown>) {
        const base = Number(page.after ?? 0) + 5;
        return {
          messages: [],
          hasOlder: false,
          hasNewer: true,
          moreUnread: true,
          modelSeenUpToSeq: base,
          readPositionAfter: base,
        };
      },
    };
    const strandedCheck = await readAgentInboxTarget(
      remDb,
      { workspaceId: WORKSPACE_ID, agentId: AGENT_ID },
      { target: "#general", limit: 5 },
      { messageReader: emptyScanReader as never },
    );
    expect(strandedCheck.hasMore).toBe(true);
    expect(strandedCheck.nextCursor).not.toBeNull();
  });

  test("Issue 5: dismissAgentInbox --before formats @handle and @app.<key> targets, excludes attachment_comments, records message_reads, and publishes conversation.read.v1", async () => {
    const publishedReads: unknown[] = [];
    const messageReadRows: unknown[] = [];
    const db = {
      $queryRaw: async (arg: readonly string[] | { strings: readonly string[] }) => {
        const sql = "strings" in arg ? arg.strings.join(" ") : arg.join(" ");
        if (sql.includes("thread_follows") || sql.includes("message_reads")) return [];
        if (sql.includes("UPDATE") && sql.includes("conversation_members"))
          return [{ conversationId: CONV_CHANNEL }, { conversationId: CONV_APP }];
        expect(sql).toContain("app_events");
        return [
          {
            memberId: "0196ed00-0000-7000-8000-000000000201",
            conversationId: CONV_CHANNEL,
            channelName: null,
            directKey: `user:${USER_ALICE}|agent:${AGENT_ID}`,
            kind: null,
            peer: "alice",
            peerKind: "human",
            appKey: null,
            maxSeq: 14,
          },
          {
            memberId: "0196ed00-0000-7000-8000-000000000202",
            conversationId: CONV_APP,
            channelName: null,
            directKey: `app:0196ed00-0000-7000-8000-000000000300|agent:${AGENT_ID}`,
            kind: "app_events",
            peer: null,
            peerKind: null,
            appKey: "github",
            maxSeq: 8,
          },
        ];
      },
      user: { findMany: async () => [{ username: "alice" }] },
      agent: { findMany: async () => [] },
      conversation: { findMany: async () => [] },
      workspaceMembership: { findUnique: async () => ({ role: "member" }) },
      messageRead: {
        createMany: async ({ data }: { data: unknown[] }) => {
          messageReadRows.push(...data);
          return { count: data.length };
        },
      },
      reminder: { findMany: async () => [] },
      $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(db),
    } as unknown as PrismaClient;

    const result = await dismissAgentInbox(
      db,
      { workspaceId: WORKSPACE_ID, agentId: AGENT_ID, userId: USER_ALICE },
      { before: "2026-11-17T00:00:00.000Z" },
      {
        realtime: {
          conversationReadChanged: async (change) => {
            publishedReads.push(change);
          },
        },
        dismissReminder: async () => {},
      },
    );
    expect(result.dismissedConversations).toBe(1);
    expect(result.dismissedAppTargets).toBe(1);
    expect(result.targets).toEqual(["@alice", "@app.github"]);
    expect(messageReadRows.length).toBeGreaterThanOrEqual(1);
    expect(publishedReads).toContainEqual({
      workspaceId: WORKSPACE_ID,
      conversationId: CONV_CHANNEL,
      memberId: "0196ed00-0000-7000-8000-000000000201",
      readThroughSequence: 14,
    });
  });

  test("Issue 7: to: 'anyone' rejects app_events/attachment_comments and allows channel members to decline ('Don't answer') with wake", async () => {
    const kindDb = (kind: string) =>
      ({
        conversation: {
          findUnique: async () => ({ channelName: null, directKey: null, kind }),
        },
        user: { findFirst: async () => null },
        conversationMember: { findFirst: async () => null },
      }) as unknown as PrismaClient;

    await expect(
      resolveChoicePayload(kindDb("app_events"), CONV_APP, {
        type: "choice",
        prompt: "Ask?",
        to: "anyone",
        options: [{ id: "ok", label: "OK" }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    await expect(
      resolveQuestionsPayload(kindDb("attachment_comments"), CONV_ATTACHMENT, {
        type: "questions",
        to: "anyone",
        questions: [
          { id: "q1", prompt: "Ask?", select: "one", options: [{ id: "ok", label: "OK" }] },
        ],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const anyonePayload = {
      type: "choice",
      prompt: "Can someone approve?",
      to: "anyone",
      options: [{ id: "yes", label: "Approve" }],
    };
    let createdDeclineDeliveries = 0;
    const cancelDb = {
      actionCard: {
        findUnique: async () => ({
          messageId: CARD_MSG_ID,
          conversationId: CONV_CHANNEL,
          workspaceId: WORKSPACE_ID,
          kind: "choice",
          state: "pending",
          expiresAt: new Date(Date.now() + 60_000),
          committedByUserId: null,
          payload: anyonePayload,
          preparedByAgentId: AGENT_ID,
          preparedByAgent: { ownerId: USER_ALICE },
        }),
        findMany: async () => [
          {
            messageId: CARD_MSG_ID,
            kind: "choice",
            payload: anyonePayload,
            draftHint: null,
            state: "pending",
            expiresAt: new Date(Date.now() + 60_000),
            committedByUserId: null,
            committedAt: null,
            result: null,
            preparedByAgentId: AGENT_ID,
          },
        ],
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
      user: {
        findUnique: async () => ({ username: "bob" }),
      },
      message: {
        findUnique: async () => ({
          sequence: 7,
          threadRootId: null,
          workspaceId: WORKSPACE_ID,
          conversation: {
            id: CONV_CHANNEL,
            channelName: "ops",
            directKey: null,
            kind: null,
            taskDiscussionOf: null,
            members: [],
          },
        }),
      },
      agent: {
        findUnique: async () => ({ computerId: "0196ed00-0000-7000-8000-000000000040" }),
        findMany: async () => [{ id: AGENT_ID, ownerId: USER_ALICE }],
      },
      agentMessageDelivery: {
        create: async () => {
          createdDeclineDeliveries += 1;
          return { deliveryId: "0196ed00-0000-7000-8000-000000000091" };
        },
      },
    } as unknown as PrismaClient;

    const views = await actionCardViews(cancelDb, WORKSPACE_ID, USER_BOB, [CARD_MSG_ID]);
    expect(views.get(CARD_MSG_ID)?.canCancel).toBe(true);

    const cards = new ActionCards(cancelDb);
    await cards.cancel({ workspaceId: WORKSPACE_ID, actorUserId: USER_BOB }, CARD_MSG_ID);
    expect(createdDeclineDeliveries).toBe(1);
  });
});
