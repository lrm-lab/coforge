import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { backfillOwnerAgentNames } from "#src/server/agents/owner-agent-rename.server";
import {
  saveProfileAndRenameAssistants,
  setLanguageAndRenameAssistants,
} from "#src/server/agents/owner-profile-writes.server";

/**
 * Owner-named assistants follow their owner (task #495), driven through the real profile and
 * language writes: a change of the owner's name or language renames the personal and
 * weekly-report assistants at once, a hand-chosen name is left alone, a Workspace the owner left
 * is untouched, and the one-time backfill catches names stored under the old rule.
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

type Fx = Awaited<ReturnType<typeof makeWorkspace>>;

async function makeUser(db: PrismaClient, displayName: string) {
  return db.user.create({
    data: { username: `own-${crypto.randomUUID().slice(0, 8)}`, displayName },
  });
}

/** A Workspace the user owns, with a personal assistant and a weekly-report assistant, each named
 * as given. */
async function makeWorkspace(
  db: PrismaClient,
  userId: string,
  names: { personal: string; weekly: string },
) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const workspace = await db.workspace.create({
    data: {
      slug: `own-${suffix}`,
      name: "Naming",
      members: { create: [{ userId, role: "owner" }] },
    },
  });
  const makeAgent = (name: string, displayName: string) =>
    db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: userId,
        name: `${name}-${suffix}`,
        displayName,
        runtimeConfig: {},
      },
    });
  await db.workspaceAssistant.create({ data: { workspaceId: workspace.id } });
  const personal = await makeAgent("assistant", names.personal);
  await db.workspaceAssistantSession.create({
    data: { workspaceId: workspace.id, userId, agentId: personal.id },
  });
  const weekly = await makeAgent("weekly", names.weekly);
  await db.weeklyReportAssistant.create({
    data: { workspaceId: workspace.id, userId, agentId: weekly.id },
  });
  return { workspace, personal, weekly };
}

const nameOf = (db: PrismaClient, id: string) =>
  db.agent
    .findUniqueOrThrow({ where: { id }, select: { displayName: true } })
    .then((a) => a.displayName);

test.skipIf(!db)(
  "saving the owner's name renames auto-named assistants and keeps a hand-chosen one",
  async () => {
    const user = await makeUser(db!, "Li Jian");
    await db!.userPreference.create({ data: { userId: user.id, language: "en" } });
    const fx = await makeWorkspace(db!, user.id, {
      personal: "Li Jian's Assistant",
      weekly: "My own name",
    });
    try {
      await saveProfileAndRenameAssistants(db!, user.id, { displayName: "Ada", description: "" });
      // The auto-named personal assistant follows; the hand-named weekly one does not.
      expect(await nameOf(db!, fx.personal.id)).toBe("Ada's Assistant");
      expect(await nameOf(db!, fx.weekly.id)).toBe("My own name");
    } finally {
      await cleanup(db!, user.id, [fx]);
    }
  },
);

test.skipIf(!db)(
  "a user who never saved a language is still recognised as auto-named (English), and language change rewords",
  async () => {
    // No userPreference row: the assistant was created in the request locale (English here), but
    // ownerNamingOf would default to Chinese. The English stored name must still count as auto.
    const user = await makeUser(db!, "Ada");
    const fx = await makeWorkspace(db!, user.id, {
      personal: "Ada's Assistant",
      weekly: "Ada's Weekly Report Assistant",
    });
    try {
      await saveProfileAndRenameAssistants(db!, user.id, { displayName: "Bob", description: "" });
      // Still no saved language → Chinese default now; the English auto-names were recognised.
      expect(await nameOf(db!, fx.personal.id)).toBe("Bob的助手");
      expect(await nameOf(db!, fx.weekly.id)).toBe("Bob的周报助手");
      // Switching language to English rewords the still-auto names.
      await setLanguageAndRenameAssistants(db!, user.id, "en");
      expect(await nameOf(db!, fx.personal.id)).toBe("Bob's Assistant");
      expect(await nameOf(db!, fx.weekly.id)).toBe("Bob's Weekly Report Assistant");
    } finally {
      await cleanup(db!, user.id, [fx]);
    }
  },
);

test.skipIf(!db)(
  "an assistant in a Workspace the owner has left is not renamed; a deleted one is skipped",
  async () => {
    const user = await makeUser(db!, "Li Jian");
    await db!.userPreference.create({ data: { userId: user.id, language: "en" } });
    const stay = await makeWorkspace(db!, user.id, {
      personal: "Li Jian's Assistant",
      weekly: "Li Jian's Weekly Report Assistant",
    });
    const left = await makeWorkspace(db!, user.id, {
      personal: "Li Jian's Assistant",
      weekly: "Li Jian's Weekly Report Assistant",
    });
    try {
      // The owner leaves `left` and the weekly assistant in `stay` is deleted.
      await db!.workspaceMembership.delete({
        where: { workspaceId_userId: { workspaceId: left.workspace.id, userId: user.id } },
      });
      await db!.agent.update({ where: { id: stay.weekly.id }, data: { deletedAt: new Date() } });
      await saveProfileAndRenameAssistants(db!, user.id, { displayName: "Ada", description: "" });
      expect(await nameOf(db!, stay.personal.id)).toBe("Ada's Assistant");
      // Left Workspace: untouched. Deleted assistant: untouched.
      expect(await nameOf(db!, left.personal.id)).toBe("Li Jian's Assistant");
      expect(await nameOf(db!, stay.weekly.id)).toBe("Li Jian's Weekly Report Assistant");
    } finally {
      await cleanup(db!, user.id, [stay, left]);
    }
  },
);

test.skipIf(!db)(
  "the backfill rewrites old-rule, generic and English auto-names for both kinds, keeping manual",
  async () => {
    const user = await makeUser(db!, "Li Jian");
    await db!.userPreference.create({ data: { userId: user.id, language: "zh-CN" } });
    const fx = await makeWorkspace(db!, user.id, {
      // Personal assistant carries its English auto-name (owner now zh-CN); weekly carries the
      // bare generic name. Both are auto-names that the current rule should rewrite.
      personal: "Li Jian's Assistant",
      weekly: "周报助手",
    });
    const manual = await makeWorkspace(db!, user.id, {
      // A hand-chosen personal name; a weekly name that is already the current zh-CN auto-name.
      personal: "My helper",
      weekly: "Li Jian的周报助手",
    });
    try {
      const dry = await backfillOwnerAgentNames({ db: db!, dryRun: true });
      // Both of fx's names are auto-names for "Li Jian" and get rewritten; manual's are left.
      expect(dry.renamed).toBeGreaterThanOrEqual(2);
      expect(await nameOf(db!, fx.weekly.id)).toBe("周报助手"); // dry run wrote nothing

      await backfillOwnerAgentNames({ db: db!, dryRun: false });
      expect(await nameOf(db!, fx.personal.id)).toBe("Li Jian的助手");
      expect(await nameOf(db!, fx.weekly.id)).toBe("Li Jian的周报助手");
      // The hand-chosen personal name is kept; the weekly one already is the current auto-name.
      expect(await nameOf(db!, manual.personal.id)).toBe("My helper");
      expect(await nameOf(db!, manual.weekly.id)).toBe("Li Jian的周报助手");
    } finally {
      await cleanup(db!, user.id, [fx, manual]);
    }
  },
);

test.skipIf(!db)(
  "an owner with no name keeps the generic assistant names, on rename and in the backfill",
  async () => {
    const user = await makeUser(db!, "Ada");
    await db!.userPreference.create({ data: { userId: user.id, language: "zh-CN" } });
    const fx = await makeWorkspace(db!, user.id, {
      personal: "Ada的助手",
      weekly: "Ada的周报助手",
    });
    try {
      // The owner clears their name (the save reads "Ada" as the previous name, then stores the
      // blank): both assistants fall back to the generic, never "Unnamed..." (the humanLabel
      // placeholder must not become a name).
      await saveProfileAndRenameAssistants(db!, user.id, { displayName: "   ", description: "" });
      expect(await nameOf(db!, fx.personal.id)).toBe("助手");
      expect(await nameOf(db!, fx.weekly.id)).toBe("周报助手");

      // A fresh backfill leaves the now-generic names alone (they are the generic auto-name).
      const before = { p: await nameOf(db!, fx.personal.id), w: await nameOf(db!, fx.weekly.id) };
      await backfillOwnerAgentNames({ db: db!, dryRun: false });
      expect(await nameOf(db!, fx.personal.id)).toBe(before.p);
      expect(await nameOf(db!, fx.weekly.id)).toBe(before.w);
    } finally {
      await cleanup(db!, user.id, [fx]);
    }
  },
);

test.skipIf(!db)(
  "legacy Unnamed... names on a nameless owner are recognised and restored to the generic",
  async () => {
    const user = await makeUser(db!, "Ada");
    await db!.userPreference.create({ data: { userId: user.id, language: "zh-CN" } });
    // Assistants stored under the pre-fix placeholder names, for an owner who has no name.
    const fx = await makeWorkspace(db!, user.id, {
      personal: "Unnamed的助手",
      weekly: "Unnamed的周报助手",
    });
    try {
      await db!.user.update({ where: { id: user.id }, data: { displayName: "" } });
      // The backfill treats the placeholder names as auto-names and restores the generic.
      await backfillOwnerAgentNames({ db: db!, dryRun: false });
      expect(await nameOf(db!, fx.personal.id)).toBe("助手");
      expect(await nameOf(db!, fx.weekly.id)).toBe("周报助手");
    } finally {
      await cleanup(db!, user.id, [fx]);
    }
  },
);

test.skipIf(!db)(
  "an owner whose stored name is the literal Unnamed placeholder counts as nameless",
  async () => {
    // Account creation stores `Unnamed` when the provider gave no usable name
    // (`initialDisplayName`): the staging case where `周报助手` was about to become
    // `Unnamed的周报助手`.
    const user = await makeUser(db!, "Unnamed");
    await db!.userPreference.create({ data: { userId: user.id, language: "zh-CN" } });
    const fx = await makeWorkspace(db!, user.id, { personal: "助手", weekly: "周报助手" });
    try {
      const dry = await backfillOwnerAgentNames({ db: db!, dryRun: true, sampleLimit: 1000 });
      expect(
        dry.samples.filter((s) => s.agentId === fx.weekly.id || s.agentId === fx.personal.id),
      ).toEqual([]);
      await backfillOwnerAgentNames({ db: db!, dryRun: false });
      expect(await nameOf(db!, fx.personal.id)).toBe("助手");
      expect(await nameOf(db!, fx.weekly.id)).toBe("周报助手");

      // Naming themselves renames both from the generic; the dry run shows the raw stored name.
      await db!.user.update({ where: { id: user.id }, data: { displayName: "Unnamed" } });
      await db!.agent.update({
        where: { id: fx.weekly.id },
        data: { displayName: "Unnamed的周报助手" },
      });
      const legacy = await backfillOwnerAgentNames({ db: db!, dryRun: true, sampleLimit: 1000 });
      expect(legacy.samples.find((s) => s.agentId === fx.weekly.id)).toMatchObject({
        to: "周报助手",
        ownerDisplayName: "Unnamed",
      });
      await saveProfileAndRenameAssistants(db!, user.id, { displayName: "Ada", description: "" });
      expect(await nameOf(db!, fx.personal.id)).toBe("Ada的助手");
      expect(await nameOf(db!, fx.weekly.id)).toBe("Ada的周报助手");
    } finally {
      await cleanup(db!, user.id, [fx]);
    }
  },
);

async function cleanup(db: PrismaClient, userId: string, workspaces: Pick<Fx, "workspace">[]) {
  for (const { workspace } of workspaces)
    await db.workspace.delete({ where: { id: workspace.id } }).catch(() => undefined);
  await db.user.delete({ where: { id: userId } }).catch(() => undefined);
}
