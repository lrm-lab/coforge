import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import {
  PrismaUserPreferencesRepository,
  UserPreferences,
} from "#src/server/db/repositories/user-preferences.repositories.server";
import { requireAiWorkbench } from "#src/server/pi-chat/ai-workbench.server";
import { canUsePiChat } from "#src/server/pi-chat/pi-chat-production.server";

/** Task #743: AI Workbench is a per-account switch, on until the person turns it off (Frank 11-09). */
test("AI Workbench is on by default, refuses once turned off, and is per account", async () => {
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
  const workspace = await db.workspace.create({
    data: {
      slug: `wb-${suffix}`,
      name: "Workbench switch",
      members: {
        create: [
          { userId: alice!.id, role: "owner" },
          { userId: bob!.id, role: "member" },
        ],
      },
    },
  });
  const computers = await Promise.all(
    [alice!, bob!].map((owner, index) =>
      db.computer.create({
        data: {
          machineId: `wb-machine-${index}-${suffix}`,
          name: `wb-computer-${index}-${suffix}`,
          kind: "cloud",
          ownerId: owner.id,
          workspaces: { create: { workspaceId: workspace.id } },
        },
      }),
    ),
  );
  const refused = async (userId: string) => {
    try {
      await requireAiWorkbench(db, userId);
    } catch (error) {
      return error instanceof AppError && error.code === "ACCESS_DENIED";
    }
    return false;
  };
  const scope = (index: number, user: typeof alice) => ({
    workspaceId: workspace.id,
    computerId: computers[index]!.id,
    userId: user!.id,
  });
  try {
    const preferences = new UserPreferences(new PrismaUserPreferencesRepository(db));

    // A person with no preferences row, and a row that never chose, are both on.
    expect((await preferences.read(alice!.id)).aiWorkbenchEnabled).toBeTrue();
    expect(await refused(alice!.id)).toBeFalse();
    await preferences.set(alice!.id, "Asia/Tokyo");
    expect((await preferences.read(alice!.id)).aiWorkbenchEnabled).toBeTrue();
    expect(await refused(alice!.id)).toBeFalse();
    expect(await canUsePiChat(db, scope(0, alice))).toBeTrue();

    // Turning it off for Alice refuses her at once and leaves Bob, in the same Workspace, on; the
    // daemon's reply frames and the gateway share `canUsePiChat`.
    expect(await preferences.setAiWorkbenchEnabled(alice!.id, false)).toBeFalse();
    expect(await refused(alice!.id)).toBeTrue();
    expect(await canUsePiChat(db, scope(0, alice))).toBeFalse();
    expect(await refused(bob!.id)).toBeFalse();
    expect(await canUsePiChat(db, scope(1, bob))).toBeTrue();
    expect((await preferences.read(alice!.id)).timeZone).toBe("Asia/Tokyo");

    // Turning it back on lets her in again.
    expect(await preferences.setAiWorkbenchEnabled(alice!.id, true)).toBeTrue();
    expect(await refused(alice!.id)).toBeFalse();
    expect(await canUsePiChat(db, scope(0, alice))).toBeTrue();
  } finally {
    await db.computer.deleteMany({ where: { id: { in: computers.map((c) => c.id) } } });
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.deleteMany({ where: { id: { in: [alice!.id, bob!.id] } } });
    await db.$disconnect();
  }
});
