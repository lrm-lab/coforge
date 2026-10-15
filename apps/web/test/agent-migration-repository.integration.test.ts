import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PrismaAgentMigrationStore } from "#src/server/db/repositories/agent-migration.repositories.server";

/**
 * The store is what keeps a migration consistent under races: a transition applies only at the
 * revision it read, PostgreSQL holds at most one active migration per Agent, and the switch moves
 * the Agent in the same transaction. Drives it against local PostgreSQL.
 *
 * Skipped unless `AGENT_MIGRATION_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.AGENT_MIGRATION_TEST_DATABASE_URL;

async function setup() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({
    data: { displayName: `mig-owner-${suffix}`, username: `mig-owner-${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `mig-${suffix}`,
      name: "Migrations",
      members: { create: { userId: owner.id, role: "owner" } },
    },
  });
  const computer = async (name: string) => {
    const row = await db.computer.create({
      data: { ownerId: owner.id, machineId: `machine-${name}-${suffix}` },
    });
    await db.workspaceComputer.create({ data: { workspaceId: workspace.id, computerId: row.id } });
    return row;
  };
  const source = await computer("a");
  const target = await computer("b");
  const agent = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      name: `mig-agent-${suffix}`,
      displayName: "Mover",
      ownerId: owner.id,
      computerId: source.id,
      runtimeConfig: {},
    },
  });
  const input = {
    workspaceId: workspace.id,
    agentId: agent.id,
    sourceComputerId: source.id,
    targetComputerId: target.id,
    requestedByUserId: owner.id,
  };
  const cleanup = async () => {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { id: { in: [source.id, target.id] } } });
    await db.user.delete({ where: { id: owner.id } });
    await db.$disconnect();
  };
  return { db, store: new PrismaAgentMigrationStore(db), input, agent, source, target, cleanup };
}

test.skipIf(!connectionString)("an Agent holds at most one active migration", async () => {
  const { store, input, cleanup } = await setup();
  try {
    const first = await store.create(input);
    expect(first).toMatchObject({ state: "requested", revision: 0, generation: 1 });
    expect(await store.create(input)).toBe("active_exists");
    if (first === "active_exists") throw new Error("unreachable");
    expect(
      await store.transition({ id: first.id, expectedRevision: 0, to: "canceled", at: new Date() }),
    ).toMatchObject({ state: "canceled" });
    expect(await store.create(input)).toMatchObject({ state: "requested" });
  } finally {
    await cleanup();
  }
});

test.skipIf(!connectionString)("a transition applies only at the revision it read", async () => {
  const { db, store, input, cleanup } = await setup();
  try {
    const created = await store.create(input);
    if (created === "active_exists") throw new Error("unreachable");
    const [one, two] = await Promise.all([
      store.transition({
        id: created.id,
        expectedRevision: 0,
        to: "source_stopped",
        at: new Date(),
      }),
      store.transition({ id: created.id, expectedRevision: 0, to: "canceled", at: new Date() }),
    ]);
    expect([one, two].filter((result) => typeof result !== "string")).toHaveLength(1);
    expect([one, two]).toContain("stale_revision");
    const row = await db.agentMigration.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.revision).toBe(1);
    expect(row.finishedAt === null).toBe(row.state === "source_stopped");
  } finally {
    await cleanup();
  }
});

test.skipIf(!connectionString)(
  "the switch moves the Agent to the target in the same write",
  async () => {
    const { db, store, input, agent, target, source, cleanup } = await setup();
    try {
      const created = await store.create(input);
      if (created === "active_exists") throw new Error("unreachable");
      const move = { agentId: agent.id, fromComputerId: source.id, toComputerId: target.id };
      const computerOf = async () =>
        (await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).computerId;

      expect(
        await store.transition({
          id: created.id,
          expectedRevision: 5,
          to: "switched",
          at: new Date(),
          move,
        }),
      ).toBe("stale_revision");
      expect(await computerOf()).toBe(source.id);

      const switched = await store.transition({
        id: created.id,
        expectedRevision: 0,
        to: "switched",
        at: new Date(),
        move,
      });
      expect(switched).toMatchObject({ state: "switched", revision: 1 });
      expect(await computerOf()).toBe(target.id);
      const row = await db.agentMigration.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.switchedAt).not.toBeNull();
    } finally {
      await cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "the switch writes nothing when the Agent already left the source",
  async () => {
    const { db, store, input, agent, target, source, cleanup } = await setup();
    try {
      const created = await store.create(input);
      if (created === "active_exists") throw new Error("unreachable");
      await db.agent.update({ where: { id: agent.id }, data: { computerId: null } });
      expect(
        await store.transition({
          id: created.id,
          expectedRevision: 0,
          to: "switched",
          at: new Date(),
          move: { agentId: agent.id, fromComputerId: source.id, toComputerId: target.id },
        }),
      ).toBe("agent_moved");
      expect(await store.find(created.id)).toMatchObject({ state: "requested", revision: 0 });
      expect((await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).computerId).toBeNull();
    } finally {
      await cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "the switch writes nothing when the target Computer is gone",
  async () => {
    const { db, store, input, agent, target, source, cleanup } = await setup();
    try {
      const created = await store.create(input);
      if (created === "active_exists") throw new Error("unreachable");
      await db.computer.update({ where: { id: target.id }, data: { deletedAt: new Date() } });
      expect(
        await store.transition({
          id: created.id,
          expectedRevision: 0,
          to: "switched",
          at: new Date(),
          move: { agentId: agent.id, fromComputerId: source.id, toComputerId: target.id },
        }),
      ).toBe("target_unavailable");
      expect(await store.find(created.id)).toMatchObject({ state: "requested", revision: 0 });
      expect((await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).computerId).toBe(
        source.id,
      );
    } finally {
      await cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "placement reads only live Agents and Computers linked to the Workspace",
  async () => {
    const { db, store, input, agent, target, cleanup } = await setup();
    try {
      expect(await store.agentPlacement(input.workspaceId, agent.id)).toEqual({
        computerId: input.sourceComputerId,
      });
      expect(await store.workspaceHasComputer(input.workspaceId, target.id)).toBeTrue();
      expect(await store.workspaceHasComputer(input.workspaceId, crypto.randomUUID())).toBeFalse();
      await db.computer.update({ where: { id: target.id }, data: { deletedAt: new Date() } });
      expect(await store.workspaceHasComputer(input.workspaceId, target.id)).toBeFalse();
      await db.agent.update({ where: { id: agent.id }, data: { deletedAt: new Date() } });
      expect(await store.agentPlacement(input.workspaceId, agent.id)).toBeNull();
    } finally {
      await cleanup();
    }
  },
);

test.skipIf(!connectionString)("keeps the bundle manifest written with a transition", async () => {
  const { store, input, cleanup } = await setup();
  try {
    const created = await store.create(input);
    if (created === "active_exists") throw new Error("unreachable");
    expect(await store.manifest(created.id)).toBeNull();
    const manifest = { format: "tar+gzip", sha256: "abc", chunks: [{ index: 0, sha256: "def" }] };
    await store.transition({
      id: created.id,
      expectedRevision: 0,
      to: "uploaded",
      at: new Date(),
      manifest,
    });
    expect(await store.manifest(created.id)).toEqual(manifest);
  } finally {
    await cleanup();
  }
});

test.skipIf(!connectionString)(
  "lists a Computer's unfinished migrations, as source or target, never a finished one",
  async () => {
    const { store, input, source, target, cleanup } = await setup();
    try {
      const created = await store.create(input);
      if (created === "active_exists") throw new Error("unreachable");
      expect((await store.activeFor(input.workspaceId, source.id)).map((row) => row.id)).toEqual([
        created.id,
      ]);
      expect((await store.activeFor(input.workspaceId, target.id)).map((row) => row.id)).toEqual([
        created.id,
      ]);
      await store.transition({ id: created.id, expectedRevision: 0, to: "failed", at: new Date() });
      expect(await store.activeFor(input.workspaceId, source.id)).toEqual([]);
    } finally {
      await cleanup();
    }
  },
);
