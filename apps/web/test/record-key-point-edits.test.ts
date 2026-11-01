import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";

test("applyConfirmedKeyPointMarkdown writes ready extraction without replacing body tabs", async () => {
  const { recordKeyPointEdits } = await import("#src/server/records/record-key-point-edits.server");
  let written: unknown = null;
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "owner" }),
    },
    weeklyReport: {
      findFirst: async () => ({
        id: "overview-1",
        authorId: "user-1",
        kind: "template",
        content: {
          tabs: { Notes: { markdown: "keep me" } },
          keyPointExtraction: { status: "ready", promptSnapshot: "团队提示词", markdown: "old" },
        },
        workspace: { slug: "acme" },
      }),
      findMany: async () => [],
      update: async ({ data }: { data: { content: unknown } }) => {
        written = data.content;
        return {};
      },
    },
  } as unknown as PrismaClient;

  const result = await recordKeyPointEdits(db).applyConfirmedKeyPointMarkdown({
    workspaceId: "ws-1",
    userId: "user-1",
    reportId: "overview-1",
    markdown: "## 新要点\n- item",
  });
  expect(result.id).toBe("overview-1");
  expect(written).toMatchObject({
    tabs: { Notes: { markdown: "keep me" } },
    keyPointExtraction: {
      status: "ready",
      markdown: "## 新要点\n- item",
      promptSnapshot: "团队提示词",
    },
  });
});
