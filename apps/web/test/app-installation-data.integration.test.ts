import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "#src/generated/prisma/client";
import { AppInstallationData } from "#src/server/app-installation-data/app-installation-data.server";
import { PrismaAppInstallationDataStore } from "#src/server/db/repositories/app-installation-data.repositories.server";
import { agentAvatarUrl } from "#src/features/agents/agent-mascot";

/**
 * What an installed app may read, against local PostgreSQL with migrations applied: the filtering
 * rules of each projection, so that nothing private reaches an app by omission.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
const db = connectionString
  ? new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
  : undefined;

afterAll(async () => {
  await db?.$disconnect();
});

const online = new Set<string>();
const imageUrl = (key: string, style: string) => `https://img.example/${key}?s=${style}`;

function dataOf(db: PrismaClient) {
  return new AppInstallationData(
    new PrismaAppInstallationDataStore(db),
    async (scopes) => scopes.map(({ computerId }) => online.has(computerId)),
    "https://coforge.example",
    imageUrl,
  );
}

async function workspaceFixture(db: PrismaClient) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({
    data: { displayName: `appdata-${suffix}`, username: `appdata-${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `appdata-${suffix}`,
      name: "Acme",
      iconObjectKey: `workspaces/icon-${suffix}`,
      members: { create: { userId: owner.id, role: "owner" } },
    },
  });
  const agent = (name: string, data: Record<string, unknown> = {}) =>
    db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: owner.id,
        name,
        displayName: name.toUpperCase(),
        description: `${name} helps`,
        runtimeConfig: { secret: "runtime" },
        ...data,
      },
    });
  const computer = async (
    machineId: string,
    data: Record<string, unknown> = {},
    into = workspace.id,
  ) => {
    const created = await db.computer.create({
      data: { ownerId: owner.id, machineId, platform: "darwin", osVersion: "26", ...data },
    });
    await db.workspaceComputer.create({ data: { workspaceId: into, computerId: created.id } });
    return created;
  };
  return {
    owner,
    workspace,
    agent,
    computer,
    async cleanup() {
      await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
      await db.computer.deleteMany({ where: { ownerId: owner.id } }).catch(() => {});
      await db.user.deleteMany({ where: { id: owner.id } }).catch(() => {});
    },
  };
}

test.skipIf(!db)(
  "the workspace projection carries the profile and nothing about its people",
  async () => {
    const f = await workspaceFixture(db!);
    try {
      const projection = await dataOf(db!).workspace(f.workspace.id);
      expect(projection).toEqual({
        id: f.workspace.id,
        slug: f.workspace.slug,
        name: "Acme",
        picture_url: imageUrl(f.workspace.iconObjectKey!, "icon256"),
        created_at: f.workspace.createdAt.toISOString(),
      });
      expect(await dataOf(db!).workspace(crypto.randomUUID())).toBeUndefined();
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)("a Workspace without an icon has a null picture", async () => {
  const f = await workspaceFixture(db!);
  try {
    await db!.workspace.update({ where: { id: f.workspace.id }, data: { iconObjectKey: null } });
    expect((await dataOf(db!).workspace(f.workspace.id))?.picture_url).toBeNull();
  } finally {
    await f.cleanup();
  }
});

test.skipIf(!db)(
  "agents are the public, live, ordinary ones, with a profile and nothing else",
  async () => {
    const f = await workspaceFixture(db!);
    try {
      const visible = await f.agent("scout", { avatarMascot: "orange" });
      const plain = await f.agent("plain");
      await f.agent("secret", { visibility: "private" });
      await f.agent("gone", { deletedAt: new Date() });
      await f.agent("assistant", { systemKind: "workspace-assistant" });
      const other = await workspaceFixture(db!);
      try {
        await other.agent("elsewhere");
        const agents = await dataOf(db!).agents(f.workspace.id);
        expect(agents).toEqual([
          {
            id: visible.id,
            handle: "scout",
            display_name: "SCOUT",
            description: "scout helps",
            avatar_url: "https://coforge.example/agent-avatars/mascot-orange-2.webp",
            created_at: visible.createdAt.toISOString(),
          },
          // An Agent whose creator picked no mascot shows the one its id chooses, as on the Web.
          {
            id: plain.id,
            handle: "plain",
            display_name: "PLAIN",
            description: "plain helps",
            avatar_url: `https://coforge.example${agentAvatarUrl(plain.id)}`,
            created_at: plain.createdAt.toISOString(),
          },
        ]);
      } finally {
        await other.cleanup();
      }
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)(
  "channels are the Workspace's live public ones: no DM, archived or hidden channel",
  async () => {
    const f = await workspaceFixture(db!);
    try {
      const make = (data: Record<string, unknown>) =>
        db!.conversation.create({ data: { workspaceId: f.workspace.id, ...data } });
      const general = await make({ channelName: "general", description: "Everyone" });
      await make({ channelName: "old", archivedAt: new Date() });
      await make({ channelName: "hidden", hiddenFromWorkspaceAt: new Date() });
      await make({ directKey: `dm-${crypto.randomUUID()}` });
      const channels = await dataOf(db!).channels(f.workspace.id);
      expect(channels).toEqual([
        {
          id: general.id,
          name: "general",
          description: "Everyone",
          created_at: general.createdAt.toISOString(),
        },
      ]);
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)(
  "computers are the Workspace's linked live ones, by kind and presence, without the machine",
  async () => {
    const f = await workspaceFixture(db!);
    const other = await workspaceFixture(db!);
    try {
      const laptop = await f.computer(`m-${crypto.randomUUID()}`, {
        name: "host.local",
        displayName: "Frank's Mac",
        computerVersion: "1.2.3",
      });
      const cloud = await f.computer(`m-${crypto.randomUUID()}`, {
        kind: "cloud",
        name: "cloud-1",
      });
      await f.computer(`m-${crypto.randomUUID()}`, { name: "deleted", deletedAt: new Date() });
      await other.computer(`m-${crypto.randomUUID()}`, { name: "elsewhere" });
      online.add(laptop.id);
      const computers = await dataOf(db!).computers(f.workspace.id);
      expect(computers).toEqual([
        {
          id: laptop.id,
          name: "Frank's Mac",
          kind: "local",
          computer_version: "1.2.3",
          online: true,
        },
        { id: cloud.id, name: "cloud-1", kind: "cloud", computer_version: null, online: false },
      ]);
      expect(JSON.stringify(computers)).not.toContain("darwin");
    } finally {
      online.clear();
      await f.cleanup();
      await other.cleanup();
    }
  },
);

test.skipIf(!db)(
  "a Computer shared with another Workspace is listed in both, with the same presence",
  async () => {
    const f = await workspaceFixture(db!);
    const other = await workspaceFixture(db!);
    try {
      const shared = await f.computer(`m-${crypto.randomUUID()}`, { name: "shared" });
      await db!.workspaceComputer.create({
        data: { workspaceId: other.workspace.id, computerId: shared.id },
      });
      expect((await dataOf(db!).computers(other.workspace.id)).map(({ id }) => id)).toEqual([
        shared.id,
      ]);
    } finally {
      await f.cleanup();
      await other.cleanup();
    }
  },
);
