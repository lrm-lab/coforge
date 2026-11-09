import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { Experiments } from "#src/server/experiments/experiments.server";
import { requireAiWorkbench } from "#src/server/pi-chat/ai-workbench.server";
import { canUsePiChat } from "#src/server/pi-chat/pi-chat-production.server";

/** AI Workbench is a Workspace experiment: on until its owner or an admin turns it off (Frank 11-09). */
test("AI Workbench follows the Workspace's switch: on by default, owner/admin only, per Workspace", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const [alice, bob] = await Promise.all(
    ["alice", "bob"].map((name) =>
      db.user.create({
        data: { displayName: `wb-${name}-${suffix}`, username: `wb-${name}-${suffix}` },
      }),
    ),
  );
  const [first, second] = await Promise.all(
    ["a", "b"].map((name) =>
      db.workspace.create({
        data: {
          slug: `wb-${name}-${suffix}`,
          name: `Workbench ${name}`,
          members: {
            create: [
              { userId: alice!.id, role: "owner" },
              { userId: bob!.id, role: "member" },
            ],
          },
        },
      }),
    ),
  );
  const computer = await db.computer.create({
    data: {
      machineId: `wb-machine-${suffix}`,
      name: `wb-computer-${suffix}`,
      kind: "cloud",
      ownerId: bob!.id,
      workspaces: { create: [{ workspaceId: first!.id }, { workspaceId: second!.id }] },
    },
  });
  const experiments = new Experiments(new PrismaExperimentsRepository(db), async () => true);
  const context = (workspace: typeof first) => ({
    workspaceId: workspace!.id,
    workspaceSlug: workspace!.slug,
  });
  const refused = async (workspace: typeof first) => {
    try {
      await requireAiWorkbench(db, workspace!.id);
    } catch (error) {
      return error instanceof AppError && error.code === "ACCESS_DENIED";
    }
    return false;
  };
  const scope = (workspace: typeof first) => ({
    workspaceId: workspace!.id,
    computerId: computer.id,
    userId: bob!.id,
  });
  try {
    // Never stored: on.
    expect(await refused(first)).toBeFalse();
    expect(await canUsePiChat(db, scope(first))).toBeTrue();

    // A member cannot switch it; nothing changes.
    await expect(experiments.set(context(first), "member", "aiWorkbench", false)).rejects.toThrow();
    expect(await refused(first)).toBeFalse();

    // An admin turns it off for the Workspace: every entry refuses, the other Workspace stays on.
    expect(
      (await experiments.set(context(first), "admin", "aiWorkbench", false)).enabled,
    ).toBeFalse();
    expect(await refused(first)).toBeTrue();
    expect(await canUsePiChat(db, scope(first))).toBeFalse();
    expect(await refused(second)).toBeFalse();
    expect(await canUsePiChat(db, scope(second))).toBeTrue();

    // Back on.
    await experiments.set(context(first), "owner", "aiWorkbench", true);
    expect(await refused(first)).toBeFalse();
    expect(await canUsePiChat(db, scope(first))).toBeTrue();
  } finally {
    await db.computer.deleteMany({ where: { id: computer.id } });
    await db.workspace.deleteMany({ where: { id: { in: [first!.id, second!.id] } } });
    await db.user.deleteMany({ where: { id: { in: [alice!.id, bob!.id] } } });
    await db.$disconnect();
  }
});
