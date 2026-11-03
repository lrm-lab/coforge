import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { AGENT_DISPLAY_NAME_MAX_LENGTH } from "#src/features/agents/agent.schemas";
import { UNNAMED_PERSON_NAME } from "#src/lib/human-label";
import { WorkspaceAssistants } from "#src/server/agents/workspace-assistants.server";
import { WorkspaceAssistantOnboarding } from "#src/server/agents/workspace-assistant-onboarding.server";
import {
  PrismaWorkspaceCatalogStore,
  WorkspaceCatalog,
} from "#src/server/workspaces/catalog.server";
import { WorkspaceJoinLinks } from "#src/server/workspaces/join-links.server";
import { PrismaWorkspaceJoinLinkStore } from "#src/server/workspaces/join-links-store.server";

/**
 * What a platform assistant is called: its owner's name in the owner's saved interface language,
 * else the provisioning request's locale, else Chinese; set once, when the Agent is made. Needs
 * `CHANNEL_TEST_DATABASE_URL` pointing at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID();
let workspaceId: string;
let userId: string;
const extraUsers: string[] = [];
// No Computer exists, so provisioning makes the Agent and its DM and starts nothing.
const onboarding = new WorkspaceAssistantOnboarding(db, {
  startCloudComputer: async () => undefined,
  startAgent: async () => {},
});

beforeAll(async () => {
  const owner = await db.user.create({
    data: { username: `naming-${suffix}`, displayName: "Naming" },
  });
  userId = owner.id;
  const workspace = await db.workspace.create({
    data: {
      name: "Assistant naming",
      slug: `naming-${suffix}`,
      members: { create: { userId, role: "owner" } },
    },
  });
  workspaceId = workspace.id;
});

async function assistantName(owner: { id: string }) {
  const session = await db.workspaceAssistantSession.findUniqueOrThrow({
    where: { workspaceId_userId: { workspaceId, userId: owner.id } },
    include: { agent: { select: { displayName: true } } },
  });
  return session.agent.displayName;
}

async function member(displayName: string, label: string) {
  const user = await db.user.create({
    data: { username: `${label}-${suffix}`, displayName },
  });
  extraUsers.push(user.id);
  await db.workspaceMembership.create({ data: { workspaceId, userId: user.id, role: "member" } });
  return user;
}

test("an assistant is named for its owner, in the language the request carries", async () => {
  const chinese = await member("Frank", "named-zh");
  const english = await member("Frank", "named-en");
  await new WorkspaceAssistants(db).ensure(workspaceId, chinese.id, { locale: "zh-CN" });
  await new WorkspaceAssistants(db).ensure(workspaceId, english.id, { locale: "en" });
  expect(await assistantName(chinese)).toBe("Frank的助手");
  expect(await assistantName(english)).toBe("Frank's Assistant");
});

test("an assistant provisioned without a request is named in Chinese, as the backfill does", async () => {
  const backfilled = await member("Frank", "named-none");
  await new WorkspaceAssistants(db).ensure(workspaceId, backfilled.id);
  expect(await assistantName(backfilled)).toBe("Frank的助手");
  // The onboarding every sidebar load goes through gives a member the same name.
  const sidebar = await member("Grace", "named-sidebar");
  await onboarding.ensure(workspaceId, sidebar.id);
  expect(await assistantName(sidebar)).toBe("Grace的助手");
});

test("an assistant is named in the owner's saved interface language, then the request's, then Chinese", async () => {
  const savedEnglish = await member("Frank", "named-saved-en");
  const savedChinese = await member("Frank", "named-saved-zh");
  await db.userPreference.create({ data: { userId: savedEnglish.id, language: "en" } });
  await db.userPreference.create({ data: { userId: savedChinese.id, language: "zh-CN" } });
  // A saved language beats the request's, and is used even when there is no request.
  await new WorkspaceAssistants(db).ensure(workspaceId, savedEnglish.id, { locale: "zh-CN" });
  await new WorkspaceAssistants(db).ensure(workspaceId, savedChinese.id, { locale: "en" });
  expect(await assistantName(savedEnglish)).toBe("Frank's Assistant");
  expect(await assistantName(savedChinese)).toBe("Frank的助手");
  const backfilled = await member("Grace", "named-saved-none");
  await db.userPreference.create({ data: { userId: backfilled.id, language: "en" } });
  await onboarding.ensure(workspaceId, backfilled.id);
  expect(await assistantName(backfilled)).toBe("Grace's Assistant");
  // No saved language (a preference row with the language unset): the request's locale decides.
  const unsaved = await member("Frank", "named-unsaved");
  await db.userPreference.create({ data: { userId: unsaved.id, timeZone: "UTC" } });
  await new WorkspaceAssistants(db).ensure(workspaceId, unsaved.id, { locale: "en" });
  expect(await assistantName(unsaved)).toBe("Frank's Assistant");
});

test("an assistant of an unnamed member reads Unnamed, and its name never outgrows an Agent's limit", async () => {
  const unnamed = await member("  ", "named-blank");
  await new WorkspaceAssistants(db).ensure(workspaceId, unnamed.id, { locale: "en" });
  expect(await assistantName(unnamed)).toBe(`${UNNAMED_PERSON_NAME}'s Assistant`);
  const longName = "名".repeat(80);
  for (const [language, tail] of [
    ["zh-CN", "的助手"],
    ["en", "'s Assistant"],
  ] as const) {
    const long = await member(longName, `named-long-${language}`);
    await new WorkspaceAssistants(db).ensure(workspaceId, long.id, { locale: language });
    const name = await assistantName(long);
    expect([...name].length).toBe(AGENT_DISPLAY_NAME_MAX_LENGTH);
    expect(name.endsWith(tail)).toBe(true);
  }
});

test("a later rename of the member does not rename the assistant", async () => {
  const renamed = await member("Frank", "named-renamed");
  await new WorkspaceAssistants(db).ensure(workspaceId, renamed.id, { locale: "en" });
  await db.user.update({ where: { id: renamed.id }, data: { displayName: "Francis" } });
  await new WorkspaceAssistants(db).ensure(workspaceId, renamed.id, { locale: "zh-CN" });
  expect(await assistantName(renamed)).toBe("Frank's Assistant");
});

test("joining by link names the assistant in the language of the join request", async () => {
  const visitor = await db.user.create({
    data: { username: `joiner-${suffix}`, displayName: "Joiner" },
  });
  extraUsers.push(visitor.id);
  const links = new WorkspaceJoinLinks(
    new PrismaWorkspaceJoinLinkStore(db),
    undefined,
    undefined,
    (joinedWorkspaceId, joinerId, options) =>
      onboarding.ensure(joinedWorkspaceId, joinerId, { startIfOwed: true, ...options }),
  );
  const link = await links.create({
    workspaceId,
    actorUserId: userId,
    maxUses: null,
    expiresAt: null,
  });
  await links.join({ token: link.token, userId: visitor.id, locale: "en" });
  expect(await assistantName(visitor)).toBe("Joiner's Assistant");
});

test("creating a Workspace names its creator's assistant in the language of the request", async () => {
  const creator = await db.user.create({
    data: { username: `creator-${suffix}`, displayName: "Creator" },
  });
  extraUsers.push(creator.id);
  const created = await new WorkspaceCatalog(new PrismaWorkspaceCatalogStore(db)).createForUser(
    creator.id,
    { name: "Fresh", slug: `fresh-${suffix}`, locale: "en" },
  );
  try {
    const session = await db.workspaceAssistantSession.findUniqueOrThrow({
      where: { workspaceId_userId: { workspaceId: created.id, userId: creator.id } },
      include: { agent: { select: { displayName: true } } },
    });
    expect(session.agent.displayName).toBe("Creator's Assistant");
  } finally {
    await db.workspace.delete({ where: { id: created.id } });
  }
});

afterAll(async () => {
  if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } });
  await db.user.deleteMany({ where: { id: { in: [userId, ...extraUsers] } } });
  await db.$disconnect();
});
