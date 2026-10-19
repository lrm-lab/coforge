import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { agentAvatarUrl } from "#src/server/agents/agent-avatar.server";
import { listArchivedAgents } from "#src/server/agents/archived-agents.server";

/**
 * Settings → Workspace profile → Archived agents: every archived Agent of the Workspace, newest
 * archive first, with the Computer it ran on, for a Workspace owner or admin only.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

test.skipIf(!connectionString)(
  "Workspace settings list the archived Agents, newest archive first, to an owner or admin only",
  async () => {
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
    const suffix = crypto.randomUUID().slice(0, 8);
    const usernames = ["owner", "admin", "member", "outsider"].map((who) => `aa-${who}-${suffix}`);
    const machineIds = [`aa-box-${suffix}`, `aa-elsewhere-${suffix}`];
    try {
      const [owner, admin, member, outsider] = await Promise.all(
        usernames.map((username) => db.user.create({ data: { username, displayName: username } })),
      );
      const workspace = await db.workspace.create({
        data: {
          slug: `aa-${suffix}`,
          name: "Archived agents",
          members: {
            create: [
              { userId: owner!.id, role: "owner" },
              { userId: admin!.id, role: "admin" },
              { userId: member!.id, role: "member" },
            ],
          },
        },
      });
      const box = await db.computer.create({
        data: { ownerId: member!.id, machineId: machineIds[0]!, name: "box", displayName: "Box" },
      });
      await db.workspaceComputer.create({
        data: { workspaceId: workspace.id, computerId: box.id },
      });
      // A Computer that left the Workspace is still the one the Agent ran on, as its profile says.
      const elsewhere = await db.computer.create({
        data: { ownerId: member!.id, machineId: machineIds[1]!, name: "elsewhere" },
      });
      const agent = (
        name: string,
        deletedAt: Date | null,
        extra: { computerId?: string; displayName?: string; visibility?: string } = {},
      ) =>
        db.agent.create({
          data: {
            workspaceId: workspace.id,
            ownerId: member!.id,
            name,
            displayName: extra.displayName ?? name.toUpperCase(),
            computerId: extra.computerId ?? null,
            visibility: extra.visibility ?? "public",
            deletedAt,
            runtimeConfig: {},
          },
        });
      // Fixed archive times, one of them shared, so the order is exact: newest archive first,
      // then by handle.
      const newer = new Date("2026-09-16T15:23:00Z");
      const older = new Date("2026-09-10T08:00:00Z");
      await agent("live", null, { computerId: box.id });
      const bravo = await agent("bravo", newer, { computerId: box.id });
      // A private Agent is still listed: only an owner or admin sees the list, and they see it.
      const alpha = await agent("alpha", newer, { visibility: "private" });
      // A blank display name reads as the handle.
      const charlie = await agent("charlie", older, { computerId: elsewhere.id, displayName: " " });

      const row = (
        agentRow: { id: string },
        displayName: string,
        archivedAt: Date,
        computerName: string | null,
      ) => ({
        id: agentRow.id,
        displayName,
        avatarUrl: agentAvatarUrl(workspace.id, agentRow.id, null),
        archivedAt,
        computerName,
      });
      const expected = [
        row(alpha, "ALPHA", newer, null),
        row(bravo, "BRAVO", newer, "Box"),
        row(charlie, "charlie", older, "elsewhere"),
      ];
      expect(await listArchivedAgents(db, workspace.id, owner!.id)).toEqual(expected);
      expect(await listArchivedAgents(db, workspace.id, admin!.id)).toEqual(expected);

      // A plain member, even the creator of every one of them, and a non-member see no list.
      await expect(listArchivedAgents(db, workspace.id, member!.id)).rejects.toThrow(
        "ACCESS_DENIED",
      );
      await expect(listArchivedAgents(db, workspace.id, outsider!.id)).rejects.toThrow(
        "ACCESS_DENIED",
      );
    } finally {
      await db.workspace.deleteMany({ where: { slug: `aa-${suffix}` } });
      await db.computer.deleteMany({ where: { machineId: { in: machineIds } } });
      await db.user.deleteMany({ where: { username: { in: usernames } } });
      await db.$disconnect();
    }
  },
);
