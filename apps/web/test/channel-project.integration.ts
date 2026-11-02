import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import type { ConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { isAppError } from "#src/lib/app-error";

/**
 * Linking, moving and unlinking a channel's Project after it was created
 * (`PublicChannels.setProject`), against local PostgreSQL.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

async function setup() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = (label: string) =>
    db.user.create({
      data: { displayName: `cp-${label}-${suffix}`, username: `cp-${label}-${suffix}` },
    });
  const [creator, bob] = await Promise.all([user("creator"), user("bob")]);
  const workspace = await db.workspace.create({
    data: {
      slug: `cp-${suffix}`,
      name: "Channel project",
      members: {
        create: [
          { userId: creator.id, role: "member" },
          { userId: bob.id, role: "member" },
        ],
      },
    },
  });
  const other = await db.workspace.create({
    data: { slug: `cp-other-${suffix}`, name: "Other", members: { create: { userId: bob.id } } },
  });
  const project = (workspaceId: string, name: string, slug: string) =>
    db.project.create({
      data: {
        workspaceId,
        name,
        slug,
        githubFullName: `acme/${slug}`,
        githubHtmlUrl: `https://github.com/acme/${slug}`,
      },
    });
  const [alpha, beta, foreign] = await Promise.all([
    project(workspace.id, "Alpha", `alpha-${suffix}`),
    project(workspace.id, "Beta", `beta-${suffix}`),
    project(other.id, "Foreign", `foreign-${suffix}`),
  ]);
  const updated: Parameters<NonNullable<ConversationRealtime["channelUpdated"]>>[0][] = [];
  const realtime: ConversationRealtime = {
    async messageAvailable() {},
    async memberChanged() {},
    async channelUpdated(input) {
      updated.push(input);
    },
  };
  const channels = new PublicChannels(db, undefined, undefined, undefined, realtime);
  const team = await channels.create(workspace.id, creator.id, `team-${suffix}`);
  await channels.join(workspace.id, bob.id, team.id);
  const projectIdOf = async () =>
    (await db.conversation.findUniqueOrThrow({ where: { id: team.id } })).projectId;
  return {
    db,
    channels,
    updated,
    suffix,
    workspace,
    creator,
    bob,
    alpha,
    beta,
    foreign,
    team,
    projectIdOf,
    async cleanup() {
      await db.workspace.deleteMany({ where: { id: { in: [workspace.id, other.id] } } });
      await db.user.deleteMany({ where: { id: { in: [creator.id, bob.id] } } });
      await db.$disconnect();
    },
  };
}

async function appErrorCode(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error)) return error.code;
    throw error;
  }
  return undefined;
}

test.skipIf(!connectionString)(
  "a channel admin links, changes and unlinks the Project, and each change is announced",
  async () => {
    const f = await setup();
    try {
      const set = (projectId: string | null) =>
        f.channels.setProject(f.workspace.id, { userId: f.creator.id }, f.team.id, projectId);
      const shown = (project: { id: string; name: string; slug: string }) => ({
        id: project.id,
        name: project.name,
        slug: project.slug,
        githubFullName: `acme/${project.slug}`,
        githubHtmlUrl: `https://github.com/acme/${project.slug}`,
      });

      expect(await set(f.alpha.id)).toEqual({ id: f.team.id, project: shown(f.alpha) });
      expect(await f.projectIdOf()).toBe(f.alpha.id);
      expect(f.updated).toHaveLength(1);
      expect(f.updated[0]).toMatchObject({
        workspaceId: f.workspace.id,
        conversationId: f.team.id,
        channel: { name: `team-${f.suffix}`, archived: false },
      });

      expect(await set(f.beta.id)).toEqual({ id: f.team.id, project: shown(f.beta) });
      expect(await f.projectIdOf()).toBe(f.beta.id);
      expect(f.updated).toHaveLength(2);

      expect(await set(null)).toEqual({ id: f.team.id, project: null });
      expect(await f.projectIdOf()).toBeNull();
      expect(f.updated).toHaveLength(3);

      // The channel page shows the new value.
      await set(f.alpha.id);
      expect((await f.channels.open(f.workspace.id, f.bob.id, f.team.id)).project).toEqual(
        shown(f.alpha),
      );
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!connectionString)("setting the Project it already has announces nothing", async () => {
  const f = await setup();
  try {
    const set = (projectId: string | null) =>
      f.channels.setProject(f.workspace.id, { userId: f.creator.id }, f.team.id, projectId);
    expect(await set(null)).toEqual({ id: f.team.id, project: null });
    await set(f.alpha.id);
    const announced = f.updated.length;
    expect(await set(f.alpha.id)).toMatchObject({ id: f.team.id, project: { id: f.alpha.id } });
    expect(f.updated).toHaveLength(announced);
    expect(await f.projectIdOf()).toBe(f.alpha.id);
  } finally {
    await f.cleanup();
  }
});

test.skipIf(!connectionString)(
  "a Project of another Workspace, a plain member and an archived channel are refused",
  async () => {
    const f = await setup();
    try {
      const asCreator = (projectId: string | null) =>
        f.channels.setProject(f.workspace.id, { userId: f.creator.id }, f.team.id, projectId);
      await asCreator(f.alpha.id);
      const announced = f.updated.length;

      // Refused the way channel creation refuses it.
      expect(await appErrorCode(asCreator(f.foreign.id))).toBe("INVALID_INPUT");
      expect(await appErrorCode(asCreator(crypto.randomUUID()))).toBe("INVALID_INPUT");

      // Needs the `update` capability: a member who is not the channel's admin has none.
      expect(
        await appErrorCode(
          f.channels.setProject(f.workspace.id, { userId: f.bob.id }, f.team.id, f.beta.id),
        ),
      ).toBe("ACCESS_DENIED");
      expect(
        await appErrorCode(
          f.channels.setProject(f.workspace.id, { userId: f.bob.id }, f.team.id, null),
        ),
      ).toBe("ACCESS_DENIED");

      await f.channels.setArchived(f.workspace.id, { userId: f.creator.id }, f.team.id, true);
      const afterArchive = f.updated.length;
      expect(await appErrorCode(asCreator(f.beta.id))).toBe("CONFLICT");
      expect(await appErrorCode(asCreator(null))).toBe("CONFLICT");

      expect(await f.projectIdOf()).toBe(f.alpha.id);
      expect(f.updated).toHaveLength(afterArchive);
      expect(afterArchive).toBeGreaterThan(announced);
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "a private channel's admin changes its Project; someone outside it cannot see the channel",
  async () => {
    const f = await setup();
    try {
      const secret = await f.channels.create(f.workspace.id, f.creator.id, `secret-${f.suffix}`, {
        visibility: "private",
      });
      const set = (userId: string, projectId: string | null) =>
        f.channels.setProject(f.workspace.id, { userId }, secret.id, projectId);

      expect(await set(f.creator.id, f.alpha.id)).toMatchObject({
        id: secret.id,
        project: { id: f.alpha.id },
      });
      expect(await set(f.creator.id, null)).toEqual({ id: secret.id, project: null });

      // Bob is in the Workspace but not in the channel: it reads as missing, as for any read.
      expect(await appErrorCode(set(f.bob.id, f.beta.id))).toBe("NOT_FOUND");
      expect(
        (await f.db.conversation.findUniqueOrThrow({ where: { id: secret.id } })).projectId,
      ).toBeNull();
    } finally {
      await f.cleanup();
    }
  },
);
