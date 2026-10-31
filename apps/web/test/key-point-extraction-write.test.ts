import { expect, test } from "bun:test";

import type { PrismaClient } from "#src/generated/prisma/client";
import { writeKeyPointExtraction } from "#src/server/records/key-point-extraction-write.server";

/**
 * Task #366: a page waiting on a report's key points polled the whole route tree every 4 seconds.
 * Writing the key points now tells the report's readers, and only them, in one broadcast.
 */
function fakeDb(report: Record<string, unknown>) {
  const writes: unknown[] = [];
  const db = {
    weeklyReport: {
      update: async (query: { data: unknown }) => {
        writes.push(query.data);
        return report;
      },
      findMany: async () => [{ authorId: "alice" }, { authorId: "bob" }],
    },
    weeklyReportFavorite: { findMany: async () => [{ userId: "carol" }] },
  } as unknown as PrismaClient;
  return { db, writes };
}

function recorder() {
  const sent: Array<{ channels: string[]; data: unknown }> = [];
  return {
    sent,
    centrifugo: {
      broadcast: async (channels: string[], data: unknown) => {
        sent.push({ channels, data });
      },
    },
  };
}

const extraction = { status: "ready" as const, promptSnapshot: "Key points", markdown: "- one" };

test("a member report's key points are announced to its author, Leader and favoriters only", async () => {
  const { db, writes } = fakeDb({
    id: "alice-report",
    workspaceId: "workspace",
    kind: "member",
    authorId: "alice",
    hiddenFromAuthor: false,
    sourceTemplate: { authorId: "leader" },
  });
  const { sent, centrifugo } = recorder();
  const content = await writeKeyPointExtraction(
    db,
    { reportId: "alice-report", content: {}, extraction },
    centrifugo,
  );
  expect(writes).toEqual([{ content }]);
  expect(content.keyPointExtraction).toMatchObject(extraction);
  expect(sent).toHaveLength(1);
  expect([...sent[0]!.channels].sort()).toEqual([
    "chat:user:alice",
    "chat:user:carol",
    "chat:user:leader",
  ]);
  // Ids only: the page reads the report again through a checked read.
  expect(sent[0]!.data).toEqual({
    type: "record.changed.v1",
    workspaceId: "workspace",
    reportId: "alice-report",
  });
});

test("an overview's key points reach the Leader and every assignee", async () => {
  const { db } = fakeDb({
    id: "template",
    workspaceId: "workspace",
    kind: "template",
    authorId: "leader",
    hiddenFromAuthor: false,
    sourceTemplate: null,
  });
  const { sent, centrifugo } = recorder();
  await writeKeyPointExtraction(db, { reportId: "template", content: {}, extraction }, centrifugo);
  expect([...sent[0]!.channels].sort()).toEqual([
    "chat:user:alice",
    "chat:user:bob",
    "chat:user:leader",
  ]);
});

test("a failed announcement leaves the write standing", async () => {
  const { db, writes } = fakeDb({
    id: "alice-report",
    workspaceId: "workspace",
    kind: "member",
    authorId: "alice",
    hiddenFromAuthor: false,
    sourceTemplate: { authorId: "leader" },
  });
  const failing = {
    broadcast: async () => {
      throw new Error("centrifugo down");
    },
  };
  await expect(
    writeKeyPointExtraction(db, { reportId: "alice-report", content: {}, extraction }, failing),
  ).resolves.toMatchObject({ keyPointExtraction: extraction });
  expect(writes).toHaveLength(1);
});
