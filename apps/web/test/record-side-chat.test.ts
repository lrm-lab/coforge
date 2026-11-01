import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { recordSideChat } from "#src/server/records/record-side-chat.server";

test("postMemberReportRuleSideChatIfApplicable skips overview subjects", async () => {
  const overviewId = "33333333-3333-3333-3333-333333333333";
  const sessionId = "44444444-4444-4444-4444-444444444444";
  let created = 0;
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "owner" }),
    },
    weeklyReport: {
      findFirst: async () => null, // not a member assignment
    },
    recordComment: {
      create: async () => {
        created += 1;
        return { id: "c1", createdAt: new Date() };
      },
      findMany: async () => [],
    },
  } as unknown as PrismaClient;

  const result = await recordSideChat(db).postMemberReportRuleSideChatIfApplicable({
    workspaceId: "55555555-5555-5555-5555-555555555555",
    userId: "66666666-6666-6666-6666-666666666666",
    subjectType: "report",
    subjectId: overviewId,
    body: "重新整理",
    assistantSessionId: sessionId,
  });
  expect(result).toBeNull();
  expect(created).toBe(0);
});

test("declineMemberReportIntent recovers original text and continues instead of cancelling", async () => {
  const reportId = "11111111-1111-1111-1111-111111111111";
  const sessionId = "22222222-2222-2222-2222-222222222222";
  const created: Array<{ body: string; payload: unknown; authorType: string }> = [];
  let findManyCalls = 0;

  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    weeklyReport: {
      findFirst: async () => ({
        id: reportId,
        cycle: { year: 2026, week: 38 },
      }),
    },
    recordComment: {
      findMany: async () => {
        findManyCalls += 1;
        // 1st: latestConfirmIntentOriginalText (desc)
        if (findManyCalls === 1) {
          return [
            {
              authorType: "assistant",
              body: "要根据已有采集包整理一份周报草稿吗？",
              payload: {
                kind: "confirm-intent",
                intent: "synthesize",
                reportId,
                year: 2026,
                week: 38,
                userGuidance: "刚才整理的周报太细碎了，天气怎么样",
              },
            },
            {
              authorType: "user",
              body: "刚才整理的周报太细碎了，天气怎么样",
              payload: null,
            },
          ];
        }
        // 2nd: listComments (asc)
        return created.map((row, index) => ({
          id: `c${index}`,
          authorType: row.authorType,
          body: row.body,
          payload: row.payload,
          createdAt: new Date(`2026-09-18T08:0${index}:00.000Z`),
          authorUser: null,
        }));
      },
      create: async ({
        data,
      }: {
        data: { body: string; payload?: unknown; authorType: string };
      }) => {
        created.push({
          body: data.body,
          payload: data.payload ?? null,
          authorType: data.authorType,
        });
        return {
          id: `c${created.length}`,
          authorType: data.authorType,
          body: data.body,
          payload: data.payload ?? null,
          createdAt: new Date(),
          authorUser: null,
        };
      },
    },
  } as unknown as PrismaClient;

  const result = await recordSideChat(db).declineMemberReportIntent({
    workspaceId: "ws-1",
    userId: "user-1",
    reportId,
    assistantSessionId: sessionId,
  });

  expect(result.originalUserText).toBe("刚才整理的周报太细碎了，天气怎么样");
  expect(created.some((row) => row.body === "不是")).toBe(true);
  const declined = created.find((row) => row.authorType === "assistant");
  expect(declined?.body).toBe("好的，我按你刚才的问题继续回答。");
  expect(declined?.payload).toEqual({ kind: "intent-declined" });
  expect(result.comments.length).toBeGreaterThan(0);
});

test("postSideChat does not auto-reply to a greeting — Agent path owns the turn", async () => {
  const created: Array<{ authorType: string; body: string }> = [];
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    recordComment: {
      findMany: async () =>
        created.map((row, index) => ({
          id: `c-${index + 1}`,
          authorType: row.authorType,
          body: row.body,
          payload: null,
          createdAt: new Date("2026-09-05T07:00:00.000Z"),
          authorUser:
            row.authorType === "user"
              ? {
                  id: "leader",
                  username: "mark",
                  displayName: "Mark",
                  avatarObjectKey: null,
                }
              : null,
        })),
      create: async ({
        data,
      }: {
        data: { authorType: string; body: string; authorUserId?: string | null };
      }) => {
        created.push({ authorType: data.authorType, body: data.body });
        return {
          id: `c-${created.length}`,
          createdAt: new Date("2026-09-05T07:00:00.000Z"),
        };
      },
    },
  } as unknown as PrismaClient;

  const rows = await recordSideChat(db).postSideChat({
    workspaceId: "ws-1",
    userId: "leader",
    subjectType: "report",
    subjectId: "11111111-1111-1111-1111-111111111111",
    assistantSessionId: "22222222-2222-2222-2222-222222222222",
    body: "你好",
  });

  expect(created).toEqual([{ authorType: "user", body: "你好" }]);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.authorType).toBe("user");
  expect(rows.some((row) => row.body.includes("周报助手"))).toBe(false);
});
