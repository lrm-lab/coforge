import { expect, test } from "bun:test";

import { AppError } from "#src/lib/app-error";
import { AgentMascots } from "#src/server/agents/agent-mascot.server";

type AgentRow = {
  id: string;
  workspaceId: string;
  ownerId: string;
  deletedAt: Date | null;
  avatarMascot: string | null;
};

function fakeDb(seed: AgentRow) {
  const row = { ...seed };
  const db = {
    // The write runs in a transaction, which a fake runs on itself.
    $transaction: async <T>(work: (tx: unknown) => Promise<T>): Promise<T> => work(db),
    agent: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        if (where.id !== row.id || where.workspaceId !== row.workspaceId) return null;
        if (where.deletedAt === null && row.deletedAt) return null;
        return { ...row };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; avatarMascot: string | null };
        data: { avatarMascot: string };
      }) => {
        if (where.id !== row.id || where.avatarMascot !== row.avatarMascot) return { count: 0 };
        row.avatarMascot = data.avatarMascot;
        return { count: 1 };
      },
    },
  };
  return { db, row };
}

const agent = (overrides: Partial<AgentRow> = {}): AgentRow => ({
  id: "agent-1",
  workspaceId: "workspace-1",
  ownerId: "owner-1",
  deletedAt: null,
  avatarMascot: null,
  ...overrides,
});

test("only the creator picks an Agent's mascot", async () => {
  const { db, row } = fakeDb(agent());
  const mascots = new AgentMascots(db as never);

  await expect(mascots.set("workspace-1", "member-2", "agent-1", "pink")).rejects.toEqual(
    new AppError("ACCESS_DENIED"),
  );
  expect(row.avatarMascot).toBeNull();

  const picked = await mascots.set("workspace-1", "owner-1", "agent-1", "pink");
  expect(row.avatarMascot).toBe("pink");
  expect(picked.avatarUrl).toBe("/agent-avatars/mascot-pink-4.webp");

  const replaced = await mascots.set("workspace-1", "owner-1", "agent-1", "black");
  expect(row.avatarMascot).toBe("black");
  expect(replaced.avatarUrl).toBe("/agent-avatars/mascot-black-4.webp");
});

test("a deleted Agent, or one of another Workspace, has no mascot to change", async () => {
  const deleted = fakeDb(agent({ deletedAt: new Date("2026-09-01T00:00:00Z") }));
  await expect(
    new AgentMascots(deleted.db as never).set("workspace-1", "owner-1", "agent-1", "pink"),
  ).rejects.toEqual(new AppError("NOT_FOUND"));
  expect(deleted.row.avatarMascot).toBeNull();

  const elsewhere = fakeDb(agent());
  await expect(
    new AgentMascots(elsewhere.db as never).set("workspace-2", "owner-1", "agent-1", "pink"),
  ).rejects.toEqual(new AppError("NOT_FOUND"));
});

test("a pick that loses a race to another pick is a conflict, not a silent overwrite", async () => {
  const { db, row } = fakeDb(agent());
  const findFirst = db.agent.findFirst;
  db.agent.findFirst = async (args) => {
    const seen = await findFirst(args);
    row.avatarMascot = "green";
    return seen;
  };
  await expect(
    new AgentMascots(db as never).set("workspace-1", "owner-1", "agent-1", "pink"),
  ).rejects.toEqual(new AppError("CONFLICT"));
  expect(row.avatarMascot).toBe("green");
});
