import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { archivedAgentWorkspaceAssignment } from "#src/server/computers/computer-workspace-files.server";

/**
 * Who may scan or delete an archived Agent's workspace from its profile, against local PostgreSQL:
 * the Computer's owner, as on the Computer page, and also a Workspace owner/admin, so an admin can
 * clean up after an Agent archived on another member's Computer. A live Agent's workspace stays
 * its Computer owner's alone.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

test.skipIf(!connectionString)(
  "a Workspace admin or the Computer's owner may manage an archived Agent's workspace",
  async () => {
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
    const suffix = crypto.randomUUID().slice(0, 8);
    const [admin, member, computerOwner] = await Promise.all(
      ["admin", "member", "box"].map((who) =>
        db.user.create({
          data: { displayName: `aw-${who}-${suffix}`, username: `aw-${who}-${suffix}` },
        }),
      ),
    );
    const workspace = await db.workspace.create({
      data: {
        slug: `aw-${suffix}`,
        name: "Archived workspaces",
        members: {
          create: [
            { userId: admin!.id, role: "admin" },
            { userId: member!.id, role: "member" },
            { userId: computerOwner!.id, role: "member" },
          ],
        },
      },
    });
    try {
      const computer = await db.computer.create({
        data: {
          ownerId: computerOwner!.id,
          machineId: crypto.randomUUID(),
          name: `box-${suffix}`,
          displayName: "Box",
        },
      });
      await db.workspaceComputer.create({
        data: { workspaceId: workspace.id, computerId: computer.id },
      });
      const agentOn = (name: string, deletedAt: Date | null) =>
        db.agent.create({
          data: {
            workspaceId: workspace.id,
            name: `${name}-${suffix}`,
            displayName: name,
            ownerId: computerOwner!.id,
            computerId: computer.id,
            deletedAt,
            runtimeConfig: {},
          },
        });
      const archived = await agentOn("archived", new Date());
      const live = await agentOn("live", null);
      const viewer = (user: { id: string }, role: string) => ({
        userId: user.id,
        workspaceId: workspace.id,
        role,
      });

      expect(
        await archivedAgentWorkspaceAssignment(db, viewer(admin!, "admin"), archived.id),
      ).toMatchObject({ computerId: computer.id });
      expect(
        await archivedAgentWorkspaceAssignment(db, viewer(computerOwner!, "member"), archived.id),
      ).toMatchObject({ computerId: computer.id });
      expect(
        await archivedAgentWorkspaceAssignment(db, viewer(member!, "member"), archived.id),
      ).toBeUndefined();
      // Only an archived Agent's workspace opens up to an admin.
      expect(
        await archivedAgentWorkspaceAssignment(db, viewer(admin!, "admin"), live.id),
      ).toBeUndefined();
    } finally {
      await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
      await db.computer.deleteMany({ where: { name: `box-${suffix}` } }).catch(() => {});
      await db.user
        .deleteMany({ where: { id: { in: [admin!.id, member!.id, computerOwner!.id] } } })
        .catch(() => {});
      await db.$disconnect();
    }
  },
);
