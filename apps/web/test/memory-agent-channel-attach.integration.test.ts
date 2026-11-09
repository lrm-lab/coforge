import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { createOwnedWorkspace } from "#src/server/db/repositories/workspace-slugs.repositories.server";
import { createChannelWithMembers } from "#src/server/conversations/channel-lifecycle.server";
import { provisionWorkspaceEnrollment } from "#src/server/workspaces/enrollment.server";
import { memoryAgentGate } from "#src/server/workspace-memory/memory-agent-gate.server";

/**
 * Task #6: the Workspace's own `memoryAgent` experiment decides whether a new public channel gets
 * the Memory Agent; the deployment's `OPENVIKING_PROTOTYPE_ENABLED` only decides whether that
 * Agent's memory is really provisioned. The unit tests behind this decide the gate and check every
 * call site resolves one; this one drives the path that stores the membership, which is what a
 * person actually sees, in each combination of the two switches.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

type Kind = "on" | "off" | "carried" | "armed";

let db: PrismaClient;
let ports: {
  db: PrismaClient;
  inboxPurge: { purge: () => Promise<void> };
};
const workspaces: Record<Kind, string> = { on: "", off: "", carried: "", armed: "" };
const owners: Record<Kind, string> = { on: "", off: "", carried: "", armed: "" };
/** Workspaces and users a case made itself, for `afterAll`. */
const createdWorkspaces: string[] = [];
const createdUsers: string[] = [];

const master = async <T>(enabled: boolean, run: () => Promise<T>): Promise<T> => {
  Bun.env.OPENVIKING_PROTOTYPE_ENABLED = enabled ? "true" : "false";
  try {
    return await run();
  } finally {
    Bun.env.OPENVIKING_PROTOTYPE_ENABLED = "true";
  }
};

async function createWorkspace(kind: Kind, memoryAgentEnabled: boolean) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const workspace = await db.workspace.create({
    data: {
      slug: `memory-attach-${kind}-${suffix}`,
      name: `Memory attach ${kind}`,
      experiments: { memoryAgent: memoryAgentEnabled },
      members: {
        create: [
          {
            role: "owner",
            user: {
              create: { displayName: `owner-${kind}`, username: `memory-attach-${kind}-${suffix}` },
            },
          },
        ],
      },
    },
    include: { members: { include: { user: true } } },
  });
  workspaces[kind] = workspace.id;
  owners[kind] = workspace.members[0]!.user.id;
}

const newChannel = (kind: Kind) =>
  createChannelWithMembers(ports, workspaces[kind], owners[kind], {
    name: `memory-${kind}-${crypto.randomUUID().slice(0, 6)}`,
    userIds: [],
    agentIds: [],
  });

const memoryAgentIn = async (channelId: string) =>
  db.conversationMember.findFirst({
    where: { conversationId: channelId, agent: { name: "memory" } },
    select: { agentId: true, channelMuted: true, leftAt: true },
  });

const memoryRow = (kind: Kind) =>
  db.workspaceMemoryAgent.findUnique({
    where: { workspaceId: workspaces[kind] },
    select: { agentId: true },
  });

beforeAll(async () => {
  if (!connectionString) return;
  Bun.env.OPENVIKING_PROTOTYPE_ENABLED = "true";
  db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  ports = { db, inboxPurge: { purge: async () => {} } };
  await createWorkspace("on", true);
  await createWorkspace("off", false);
  await createWorkspace("carried", true);
  await createWorkspace("armed", true);
});

afterAll(async () => {
  if (!connectionString) return;
  const ids = [...Object.values(workspaces).filter(Boolean), ...createdWorkspaces];
  if (ids.length > 0) await db.workspace.deleteMany({ where: { id: { in: ids } } });
  const ownerIds = [...Object.values(owners).filter(Boolean), ...createdUsers];
  if (ownerIds.length > 0) await db.user.deleteMany({ where: { id: { in: ownerIds } } });
  await db.$disconnect();
  delete Bun.env.OPENVIKING_PROTOTYPE_ENABLED;
});

test.skipIf(!connectionString)(
  "a public channel in a Workspace that switched the experiment on gets the Memory Agent",
  async () => {
    const { id } = await newChannel("on");

    const row = await memoryRow("on");
    expect(await memoryAgentIn(id)).toEqual({
      agentId: row!.agentId,
      channelMuted: false,
      leftAt: null,
    });
  },
);

test.skipIf(!connectionString)(
  "a Workspace that switched the experiment off gets nothing, deployment switch off",
  async () => {
    const { id } = await master(false, () => newChannel("off"));

    expect(await memoryRow("off")).toBeNull();
    expect(await memoryAgentIn(id)).toBeNull();
    // Nothing to remember either: the Workspace never asked for memory.
    expect(
      await db.workspaceMemoryProfile.findUnique({ where: { workspaceId: workspaces.off } }),
    ).toBeNull();
  },
);

test.skipIf(!connectionString)(
  "a Workspace that switched the experiment off gets nothing, deployment switch on",
  async () => {
    const { id } = await newChannel("off");

    expect(await memoryRow("off")).toBeNull();
    expect(await memoryAgentIn(id)).toBeNull();
  },
);

test.skipIf(!connectionString)(
  "a Workspace the migration backfilled as on keeps its Agent and reuses it for new channels",
  async () => {
    const first = await newChannel("carried");
    const row = await memoryRow("carried");

    const second = await newChannel("carried");
    expect((await memoryAgentIn(second.id))?.agentId).toBe(row!.agentId);
    // Reused, not recreated: the Workspace still has exactly one memory Agent.
    expect(
      await db.agent.count({ where: { workspaceId: workspaces.carried, name: "memory" } }),
    ).toBe(1);
    expect((await memoryAgentIn(first.id))?.agentId).toBe(row!.agentId);
  },
);

test.skipIf(!connectionString)(
  "an Agent that already exists still joins a new channel while the deployment's switch is off",
  async () => {
    // The pre-#6 behaviour for this case, which must not regress: the Workspace switched the
    // experiment on, the Agent is there, so a new channel gets it whatever the deployment says.
    const first = await newChannel("carried");
    const row = await memoryRow("carried");

    const { id } = await master(false, () => newChannel("carried"));
    expect((await memoryAgentIn(id))?.agentId).toBe(row!.agentId);
    expect((await memoryAgentIn(first.id))?.agentId).toBe(row!.agentId);
  },
);

test.skipIf(!connectionString)(
  "a Workspace that is on while the deployment is off plants its Agent and records the refusal",
  async () => {
    const { id } = await master(false, () => newChannel("armed"));

    // Armed for later: the Agent is planted and joins, its memory is not provisioned yet.
    const row = await memoryRow("armed");
    expect(row).not.toBeNull();
    expect((await memoryAgentIn(id))?.agentId).toBe(row!.agentId);
    const profile = await db.workspaceMemoryProfile.findUniqueOrThrow({
      where: { workspaceId: workspaces.armed },
      select: { desired: true, sanitizedFailureCode: true },
    });
    expect(profile).toEqual({ desired: "off", sanitizedFailureCode: "prototype_disabled" });
  },
);

test.skipIf(!connectionString)(
  "the deployment's master switch alone decides whether the Agent's memory is provisioned",
  async () => {
    expect(await memoryAgentGate(db, workspaces.on)).toEqual({ prototypeEnabled: true });
    await master(false, async () => {
      expect(await memoryAgentGate(db, workspaces.on)).toEqual({ prototypeEnabled: false });
    });
  },
);

test.skipIf(!connectionString)(
  "a Workspace created the way the product creates one gets no Memory Agent in #general",
  async () => {
    // The path production took: `provisionWorkspaceEnrollment` (and the catalog's create) attach to
    // #general without naming the Workspace's answer, so the default must be the experiment's own
    // default — off for a new Workspace (task #6).
    const suffix = crypto.randomUUID().slice(0, 8);
    const owner = await db.user.create({
      data: { displayName: "new-owner", username: `memory-new-${suffix}` },
    });
    const workspace = await createOwnedWorkspace(
      db,
      { slug: `memory-new-${suffix}`, name: "New Workspace", userId: owner.id },
      { id: true },
    );
    createdWorkspaces.push(workspace.id);
    createdUsers.push(owner.id);
    await provisionWorkspaceEnrollment(db, workspace.id, owner.id);

    const general = await db.conversation.findUniqueOrThrow({
      where: { workspaceId_channelName: { workspaceId: workspace.id, channelName: "general" } },
      select: { id: true },
    });
    expect(
      await db.conversationMember.findFirst({
        where: { conversationId: general.id, agent: { name: "memory" } },
      }),
    ).toBeNull();
    expect(
      await db.workspaceMemoryAgent.findUnique({ where: { workspaceId: workspace.id } }),
    ).toBeNull();
    expect(
      await db.workspaceMemoryProfile.findUnique({ where: { workspaceId: workspace.id } }),
    ).toBeNull();
  },
);
