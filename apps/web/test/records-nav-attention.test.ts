import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { recordNavAttention } from "#src/server/records/record-nav-attention.server";

test("loadNavAttention reads every applied stream with two batched queries", async () => {
  const now = new Date("2026-09-16T01:30:00Z");
  let findManyCalls = 0;
  const db = {
    workspaceMembership: { findUnique: async () => ({ role: "owner" }) },
    weeklyReportTemplate: {
      findMany: async () => [
        { id: "settings-late", sendWeekday: 3, sendTime: "15:00" },
        { id: "settings-soon", sendWeekday: 3, sendTime: "10:00" },
        { id: "settings-sent", sendWeekday: 3, sendTime: "10:00" },
      ],
    },
    weeklyReport: {
      findMany: async (args: { where: { submissions: { some?: unknown; none?: unknown } } }) => {
        findManyCalls += 1;
        return args.where.submissions.some
          ? [{ settingsId: "settings-sent" }]
          : [{ settingsId: "settings-soon", content: null }];
      },
      findFirst: async () => null,
    },
  } as unknown as PrismaClient;

  const result = await recordNavAttention(db).loadNavAttention({
    workspaceId: "workspace-1",
    userId: "leader",
    now,
  });

  expect(result).toEqual({ preview: true });
  expect(findManyCalls).toBe(2);
});

test("loadNavAttention stays quiet when the only armed stream was already sent", async () => {
  const now = new Date("2026-09-16T01:30:00Z");
  const db = {
    workspaceMembership: { findUnique: async () => ({ role: "owner" }) },
    weeklyReportTemplate: {
      findMany: async () => [{ id: "settings-sent", sendWeekday: 3, sendTime: "10:00" }],
    },
    weeklyReport: {
      findMany: async (args: { where: { submissions: { some?: unknown } } }) =>
        args.where.submissions.some ? [{ settingsId: "settings-sent" }] : [],
      findFirst: async () => null,
    },
  } as unknown as PrismaClient;

  const result = await recordNavAttention(db).loadNavAttention({
    workspaceId: "workspace-1",
    userId: "leader",
    now,
  });

  expect(result).toEqual({ preview: false });
});

test("loadNavAttention lights the Records rail when the viewer has an unread assignment", async () => {
  const db = {
    workspaceMembership: { findUnique: async () => ({ role: "owner" }) },
    weeklyReportTemplate: { findMany: async () => [] },
    weeklyReport: {
      findFirst: async (args: {
        where: {
          kind?: string;
          authorId?: string;
          sourceTemplateId?: { not: null };
          hiddenFromAuthor?: boolean;
          content?: { path: string[]; equals: boolean };
        };
      }) => {
        expect(args.where.kind).toBe("member");
        expect(args.where.authorId).toBe("member-1");
        expect(args.where.sourceTemplateId).toEqual({ not: null });
        expect(args.where.hiddenFromAuthor).toBe(false);
        expect(args.where.content).toEqual({ path: ["assignment", "unread"], equals: true });
        return { id: "assignment-1" };
      },
    },
  } as unknown as PrismaClient;

  const result = await recordNavAttention(db).loadNavAttention({
    workspaceId: "workspace-1",
    userId: "member-1",
  });

  expect(result).toEqual({ preview: true });
});

test("loadNavAttention stays quiet when the member has no unread assignment", async () => {
  const db = {
    workspaceMembership: { findUnique: async () => ({ role: "owner" }) },
    weeklyReportTemplate: { findMany: async () => [] },
    weeklyReport: {
      findFirst: async () => null,
    },
  } as unknown as PrismaClient;

  const result = await recordNavAttention(db).loadNavAttention({
    workspaceId: "workspace-1",
    userId: "member-1",
  });

  expect(result).toEqual({ preview: false });
});
