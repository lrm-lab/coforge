import { expect, test } from "bun:test";
import { PrismaAgentControlStore } from "#src/server/db/repositories/agent-control.repositories.server";
import type { PrismaClient } from "#src/generated/prisma/client";

function capturingDb(rows: { id: string; deadlineAtMs: bigint | number | null }[]) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const db = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ sql: strings.join("?"), values });
      return rows;
    },
  } as unknown as PrismaClient;
  return { db, calls };
}

test("the candidate query filters the starting phase and the cut-off in SQL and bounds the batch", async () => {
  const { db, calls } = capturingDb([]);
  await new PrismaAgentControlStore(db).listStartupCandidates(1_800_000_000_000, 50);
  const { sql, values } = calls[0]!;
  expect(sql).toContain(`"controlState"->>'phase' = 'starting'`);
  expect(sql).toContain(`"controlState"->>'deadlineAtMs'`);
  expect(sql).toContain(`"deletedAt" IS NULL`);
  expect(sql).toContain("LIMIT");
  expect(values).toContain(50);
  expect(values).toContain(1_800_000_000_000);
});

test("candidates come back as ids with a cursor for the next batch", async () => {
  const { db } = capturingDb([
    { id: "a1", deadlineAtMs: 100 },
    { id: "a2", deadlineAtMs: null },
  ]);
  const page = await new PrismaAgentControlStore(db).listStartupCandidates(500, 2);
  expect(page.ids).toEqual(["a1", "a2"]);
  expect(page.next).toEqual({ deadlineAtMs: 0, id: "a2" });
});

test("a short batch has no next cursor", async () => {
  const { db } = capturingDb([{ id: "a1", deadlineAtMs: 100 }]);
  const page = await new PrismaAgentControlStore(db).listStartupCandidates(500, 2);
  expect(page).toEqual({ ids: ["a1"], next: undefined });
});

test("a following batch resumes after the cursor so one unsettleable row cannot hold the sweep", async () => {
  const { db, calls } = capturingDb([]);
  await new PrismaAgentControlStore(db).listStartupCandidates(500, 2, {
    deadlineAtMs: 100,
    id: "a1",
  });
  expect(calls[0]!.values).toContain(100);
  expect(calls[0]!.values).toContain("a1");
});
