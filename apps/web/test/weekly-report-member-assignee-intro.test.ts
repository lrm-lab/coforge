import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { RecordCatalog } from "#src/server/records/record-catalog.server";
import { recordSideChat } from "#src/server/records/record-side-chat.server";
import {
  looksLikeMemberGenerateOfferAccept,
  parseRecordAssistantPayload,
} from "#src/features/records/weekly-highlight-extract";

test("looksLikeMemberGenerateOfferAccept matches E1 intent", () => {
  expect(looksLikeMemberGenerateOfferAccept("需要")).toBe(true);
  expect(looksLikeMemberGenerateOfferAccept("帮我生成")).toBe(true);
  expect(looksLikeMemberGenerateOfferAccept("随便聊聊")).toBe(false);
});

test("looksLikeCollectAgainRequest and synthesize intents match product phrases", async () => {
  const {
    looksLikeCollectAgainRequest,
    looksLikeSynthesizeWeeklyReportRequest,
    looksLikeMemberReportRuleIntent,
  } = await import("#src/features/records/weekly-highlight-extract");
  expect(looksLikeCollectAgainRequest("再采集一遍")).toBe(true);
  expect(looksLikeCollectAgainRequest("重新采集")).toBe(true);
  expect(looksLikeCollectAgainRequest("随便聊聊")).toBe(false);
  expect(looksLikeSynthesizeWeeklyReportRequest("整理周报")).toBe(true);
  expect(looksLikeSynthesizeWeeklyReportRequest("根据采集包总结一下")).toBe(true);
  expect(looksLikeSynthesizeWeeklyReportRequest("天气怎么样")).toBe(false);
  expect(looksLikeMemberReportRuleIntent("再采集一遍")).toBe(true);
  expect(looksLikeMemberReportRuleIntent("整理周报")).toBe(true);
  expect(looksLikeMemberReportRuleIntent("需要")).toBe(true);
  expect(looksLikeSynthesizeWeeklyReportRequest("重新整理")).toBe(true);
});

test("shouldUseMemberReportRulePath only on member-assignee surface", async () => {
  const { shouldUseMemberReportRulePath } =
    await import("#src/features/records/weekly-highlight-extract");
  expect(shouldUseMemberReportRulePath("member-assignee", "重新整理")).toBe(true);
  expect(shouldUseMemberReportRulePath("member-assignee", "整理周报")).toBe(true);
  expect(shouldUseMemberReportRulePath("plain", "重新整理")).toBe(false);
  expect(shouldUseMemberReportRulePath("format", "重新整理")).toBe(false);
  expect(shouldUseMemberReportRulePath("member-leader", "重新整理")).toBe(false);
  expect(shouldUseMemberReportRulePath("plain", "hi")).toBe(false);
});

test("parseRecordAssistantPayload accepts confirm-intent and intent-declined", () => {
  expect(
    parseRecordAssistantPayload({
      kind: "confirm-intent",
      intent: "collect-again",
      reportId: "11111111-1111-1111-1111-111111111111",
      year: 2026,
      week: 38,
    }),
  ).toEqual({
    kind: "confirm-intent",
    intent: "collect-again",
    reportId: "11111111-1111-1111-1111-111111111111",
    year: 2026,
    week: 38,
  });
  expect(
    parseRecordAssistantPayload({
      kind: "confirm-intent",
      intent: "synthesize",
      reportId: "11111111-1111-1111-1111-111111111111",
      year: 2026,
      week: 38,
      userGuidance: "太细碎了，更概括一些，重新整理周报",
    }),
  ).toEqual({
    kind: "confirm-intent",
    intent: "synthesize",
    reportId: "11111111-1111-1111-1111-111111111111",
    year: 2026,
    week: 38,
    userGuidance: "太细碎了，更概括一些，重新整理周报",
  });
  expect(parseRecordAssistantPayload({ kind: "intent-declined" })).toEqual({
    kind: "intent-declined",
  });
});

test("parseRecordAssistantPayload accepts offer-help-generate", () => {
  expect(parseRecordAssistantPayload({ kind: "offer-help-generate" })).toEqual({
    kind: "offer-help-generate",
  });
});

test("ensureAssistantIntro posts assignee welcome with 需要 offer", async () => {
  const created: Array<{ body: string; payload: unknown }> = [];
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    recordComment: {
      findMany: async () => [],
      create: async ({
        data,
      }: {
        data: { body: string; payload?: unknown; authorType: string };
      }) => {
        created.push({ body: data.body, payload: data.payload ?? null });
        return {
          id: "c1",
          authorType: data.authorType,
          body: data.body,
          payload: data.payload ?? null,
          createdAt: new Date("2026-09-17T08:00:00.000Z"),
          authorUser: null,
        };
      },
    },
    weeklyReport: {
      findFirst: async () => ({
        cycle: { year: 2026, week: 36 },
        author: { displayName: "胡静", username: "hujing" },
      }),
    },
  } as unknown as PrismaClient;

  // Second listComments after write — return the created row.
  let listed = 0;
  (db as { recordComment: { findMany: () => Promise<unknown[]> } }).recordComment.findMany =
    async () => {
      listed += 1;
      if (listed === 1) return [];
      return [
        {
          id: "c1",
          authorType: "assistant",
          body: created[0]!.body,
          payload: created[0]!.payload,
          createdAt: new Date("2026-09-17T08:00:00.000Z"),
          authorUser: null,
        },
      ];
    };

  const rows = await new RecordCatalog(db).ensureAssistantIntro({
    workspaceId: "ws-1",
    userId: "user-1",
    subjectType: "report",
    subjectId: "11111111-1111-1111-1111-111111111111",
    assistantSessionId: "session-1",
    surface: "member-assignee",
  });

  expect(created).toHaveLength(1);
  expect(created[0]!.body).toContain("胡静");
  expect(created[0]!.body).toContain("2026 W36");
  expect(created[0]!.body).toContain("是否需要我来帮你直接生成");
  expect(created[0]!.payload).toEqual({ kind: "offer-help-generate" });
  expect(rows).toHaveLength(1);
});

test("ensureAssistantIntro posts format offer-send when the send window is open", async () => {
  const created: Array<{ body: string; payload: unknown }> = [];
  const formatRow = {
    id: "11111111-1111-1111-1111-111111111111",
    authorId: "leader",
    kind: "template",
    settingsId: "settings-1",
    content: { tabs: { Summary: { markdown: "outline" } } },
    cycle: { year: 2026, week: 36 },
    updatedAt: new Date("2026-09-05T07:00:00.000Z"),
    author: { displayName: "Mark", username: "mark" },
  };
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
      findMany: async () => [],
    },
    weeklyReport: {
      findFirst: async (query: {
        where?: { submissions?: { some?: unknown; none?: unknown } };
      }) => {
        if (query.where?.submissions?.some) return null;
        if (query.where?.submissions?.none) return { id: formatRow.id };
        return formatRow;
      },
    },
    weeklyReportTemplate: {
      findFirst: async () => ({
        id: "settings-1",
        sendWeekday: 5,
        sendTime: "15:00",
        scheduleEnabled: true,
        applied: true,
        allMembers: false,
        recipients: [
          {
            user: {
              id: "m1",
              displayName: "Ada",
              username: "ada",
              avatarObjectKey: null,
            },
          },
        ],
      }),
    },
    recordComment: {
      findMany: async () => [],
      create: async ({
        data,
      }: {
        data: { body: string; payload?: unknown; authorType: string };
      }) => {
        created.push({ body: data.body, payload: data.payload ?? null });
        return {
          id: "c1",
          authorType: data.authorType,
          body: data.body,
          payload: data.payload ?? null,
          createdAt: new Date("2026-09-05T07:00:00.000Z"),
          authorUser: null,
        };
      },
    },
  } as unknown as PrismaClient;

  (
    db as {
      recordComment: {
        findMany: (query?: { where?: { assistantSessionId?: string } }) => Promise<unknown[]>;
      };
    }
  ).recordComment.findMany = async () => {
    if (created.length === 0) return [];
    return [
      {
        id: "c1",
        authorType: "assistant",
        body: created[0]!.body,
        payload: created[0]!.payload,
        createdAt: new Date("2026-09-05T07:00:00.000Z"),
        authorUser: null,
      },
    ];
  };

  const rows = await new RecordCatalog(db).ensureAssistantIntro({
    workspaceId: "ws-1",
    userId: "leader",
    subjectType: "report",
    subjectId: formatRow.id,
    assistantSessionId: "session-1",
    surface: "format",
    // Friday 14:30 Shanghai for a 15:00 send
    now: new Date("2026-09-04T06:30:00.000Z"),
  });

  expect(created).toHaveLength(1);
  expect(created[0]!.body).toBe("hi，Mark，2026 W36的工作周报模板已生成，请确认是否发送。");
  expect(created[0]!.payload).toMatchObject({
    kind: "offer-send",
    year: 2026,
    week: 36,
    weekTitle: "2026 W36 (08.31-09.04)",
  });
  expect(rows).toHaveLength(1);
});

test("ensureAssistantIntro does not fan out offer-send when another session already has this week's card", async () => {
  const created: Array<{ body: string; payload: unknown; assistantSessionId?: string | null }> = [];
  const formatRow = {
    id: "11111111-1111-1111-1111-111111111111",
    authorId: "leader",
    kind: "template",
    settingsId: "settings-1",
    content: { tabs: { Summary: { markdown: "outline" } } },
    cycle: { year: 2026, week: 36 },
    updatedAt: new Date("2026-09-05T07:00:00.000Z"),
    author: { displayName: "Mark", username: "mark" },
  };
  const priorOffer = {
    id: "c-prior",
    authorType: "assistant",
    body: "hi，Mark，2026 W36的工作周报模板已生成，请确认是否发送。",
    payload: {
      kind: "offer-send",
      year: 2026,
      week: 36,
      weekTitle: "2026 W36 (08.31-09.04)",
    },
    assistantSessionId: "session-1",
    createdAt: new Date("2026-09-04T06:00:00.000Z"),
    authorUser: null,
  };
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
      findMany: async () => [],
    },
    weeklyReport: {
      findFirst: async (query: {
        where?: { submissions?: { some?: unknown; none?: unknown } };
      }) => {
        if (query.where?.submissions?.some) return null;
        if (query.where?.submissions?.none) return { id: formatRow.id };
        return formatRow;
      },
    },
    weeklyReportTemplate: {
      findFirst: async () => ({
        id: "settings-1",
        sendWeekday: 5,
        sendTime: "15:00",
        scheduleEnabled: true,
        applied: true,
        allMembers: false,
        recipients: [
          {
            user: {
              id: "m1",
              displayName: "Ada",
              username: "ada",
              avatarObjectKey: null,
            },
          },
        ],
      }),
    },
    recordComment: {
      findMany: async (query: {
        where?: { assistantSessionId?: string | null };
        take?: number;
      }) => {
        // Cross-session scan (no session filter) sees the prior offer.
        if (!query.where?.assistantSessionId) return [priorOffer];
        // New session thread is empty.
        if (query.where.assistantSessionId === "session-2") return [];
        return [priorOffer];
      },
      create: async ({
        data,
      }: {
        data: {
          body: string;
          payload?: unknown;
          authorType: string;
          assistantSessionId?: string | null;
        };
      }) => {
        created.push({
          body: data.body,
          payload: data.payload ?? null,
          assistantSessionId: data.assistantSessionId,
        });
        return {
          id: `c-${created.length}`,
          authorType: data.authorType,
          body: data.body,
          payload: data.payload ?? null,
          createdAt: new Date("2026-09-05T07:00:00.000Z"),
          authorUser: null,
        };
      },
    },
  } as unknown as PrismaClient;

  const rows = await new RecordCatalog(db).ensureAssistantIntro({
    workspaceId: "ws-1",
    userId: "leader",
    subjectType: "report",
    subjectId: formatRow.id,
    assistantSessionId: "session-2",
    surface: "format",
    now: new Date("2026-09-04T06:30:00.000Z"),
  });

  expect(
    created.some((row) => (row.payload as { kind?: string } | null)?.kind === "offer-send"),
  ).toBe(false);
  expect(created).toHaveLength(0);
  expect(rows).toHaveLength(0);
});

test("ensureAssistantIntro leaves a new session empty after this week's send was cancelled", async () => {
  const created: Array<{ body: string }> = [];
  const formatRow = {
    id: "11111111-1111-1111-1111-111111111111",
    authorId: "leader",
    kind: "template",
    settingsId: "settings-1",
    content: {
      tabs: { Summary: { markdown: "outline" } },
      schedule: { cancelledYear: 2026, cancelledWeek: 36, dismissSend: true },
    },
    cycle: { year: 2026, week: 36 },
    updatedAt: new Date("2026-09-05T07:00:00.000Z"),
    author: { displayName: "Mark", username: "mark" },
  };
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
      findMany: async () => [],
    },
    weeklyReport: {
      findFirst: async (query: {
        where?: { submissions?: { some?: unknown; none?: unknown } };
      }) => {
        if (query.where?.submissions?.some) return null;
        if (query.where?.submissions?.none) {
          return { id: formatRow.id, content: formatRow.content };
        }
        return formatRow;
      },
    },
    weeklyReportTemplate: {
      findFirst: async () => ({
        id: "settings-1",
        sendWeekday: 5,
        sendTime: "15:00",
        scheduleEnabled: true,
        applied: true,
        allMembers: false,
        recipients: [],
      }),
    },
    recordComment: {
      findMany: async () => [],
      create: async ({ data }: { data: { body: string } }) => {
        created.push({ body: data.body });
        return {
          id: `c-${created.length}`,
          authorType: "assistant",
          body: data.body,
          payload: null,
          createdAt: new Date("2026-09-05T07:00:00.000Z"),
          authorUser: null,
        };
      },
    },
  } as unknown as PrismaClient;

  const rows = await new RecordCatalog(db).ensureAssistantIntro({
    workspaceId: "ws-1",
    userId: "leader",
    subjectType: "report",
    subjectId: formatRow.id,
    assistantSessionId: "session-new",
    surface: "format",
    now: new Date("2026-09-04T06:30:00.000Z"),
  });

  expect(created).toHaveLength(0);
  expect(rows).toHaveLength(0);
});
