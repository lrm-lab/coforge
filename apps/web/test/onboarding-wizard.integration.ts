import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { isAppError } from "#src/lib/app-error";
import { completeFirstSignIn } from "#src/server/auth/first-sign-in.server";
import { WorkspaceAssistants } from "#src/server/agents/workspace-assistants.server";
import { OnboardingWizard } from "#src/server/onboarding/onboarding-wizard.server";
import { PrismaWorkspaceCatalogStore } from "#src/server/workspaces/catalog.server";
import { workspaceJoinLinks } from "#src/server/workspaces/join-links-store.server";

/**
 * The first-sign-in setup wizard's server side against local PostgreSQL: who is put into it, what
 * finishing or skipping does (role saved, pending cleared, the assistant started after), and how
 * the assistant is bound to the chosen computer and runtime while it has never run.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const created: { users: string[]; workspaces: string[] } = { users: [], workspaces: [] };

async function person(label: string) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await db.user.create({
    data: { username: `wiz-${label}-${suffix}`, displayName: `wiz-${suffix}` },
  });
  created.users.push(user.id);
  return { user, suffix };
}

/** A person who just signed in for the first time: their own Workspace, wizard pending. */
async function signedUp(label: string) {
  const { user, suffix } = await person(label);
  const result = await completeFirstSignIn({
    db,
    user,
    displayName: `Wiz ${suffix}`,
    locale: "en",
  });
  if (!result.ok || !result.workspaceId) throw new Error("first sign-in did not make a Workspace");
  created.workspaces.push(result.workspaceId);
  return { user, suffix, workspaceId: result.workspaceId };
}

async function localComputer(userId: string, workspaceId: string) {
  return db.computer.create({
    data: {
      ownerId: userId,
      machineId: `wiz-${crypto.randomUUID()}`,
      kind: "local",
      workspaces: { create: { workspaceId } },
    },
  });
}

function wizard(
  options: {
    canRun?: boolean;
    started?: { workspaceId: string; userId: string }[];
    online?: ReadonlySet<string>;
  } = {},
) {
  return new OnboardingWizard(db, {
    online: async (scopes) =>
      scopes.map(({ computerId }) => options.online?.has(computerId) ?? false),
    canRun: async () => options.canRun ?? true,
    startAssistant: async (workspaceId, userId) => {
      options.started?.push({ workspaceId, userId });
      return new WorkspaceAssistants(db).ensure(workspaceId, userId);
    },
  });
}

const pendingOf = async (workspaceId: string, userId: string) =>
  (
    await db.workspaceMemberPreference.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    })
  )?.onboardingPendingSince ?? null;

async function refusal(run: Promise<unknown>) {
  try {
    await run;
  } catch (error) {
    if (isAppError(error)) return error.errorId ?? error.code;
    throw error;
  }
  return undefined;
}

test("first sign-in puts the person's own new Workspace into the wizard, once", async () => {
  const { user, workspaceId, suffix } = await signedUp("own");
  const since = await pendingOf(workspaceId, user.id);
  expect(since).toBeInstanceOf(Date);
  // A repeated submit finds the Workspace and leaves the moment alone, even after it was cleared.
  await completeFirstSignIn({ db, user, displayName: `Wiz ${suffix}`, locale: "en" });
  expect(await pendingOf(workspaceId, user.id)).toEqual(since);
  await wizard().complete(workspaceId, user.id, {});
  await completeFirstSignIn({ db, user, displayName: `Wiz ${suffix}`, locale: "en" });
  expect(await pendingOf(workspaceId, user.id)).toBeNull();
});

test("joining by link or creating another Workspace never starts the wizard", async () => {
  const owner = await signedUp("host");
  const joiner = await person("joiner");
  const links = workspaceJoinLinks(db);
  const link = await links.create({
    workspaceId: owner.workspaceId,
    actorUserId: owner.user.id,
    maxUses: null,
    expiresAt: null,
  });
  await links.join({ token: link.token, userId: joiner.user.id });
  expect(await pendingOf(owner.workspaceId, joiner.user.id)).toBeNull();
  const other = await new PrismaWorkspaceCatalogStore(db).createForUser({
    slug: `wiz-other-${owner.suffix}`,
    name: "Other",
    userId: owner.user.id,
  });
  created.workspaces.push(other.id);
  expect(await pendingOf(other.id, owner.user.id)).toBeNull();
  expect(await wizard().state(owner.workspaceId, joiner.user.id)).toBeNull();
});

test("the state is the assistant's name and face with the connect step's computers, only while pending", async () => {
  const { user, workspaceId, suffix } = await signedUp("state");
  const state = await wizard().state(workspaceId, user.id);
  expect(state).toEqual({
    computers: [],
    assistant: {
      agentId: expect.any(String),
      displayName: `wiz-${suffix}'s Assistant`,
      avatarMascot: null,
    },
  });
  await wizard().complete(workspaceId, user.id, {});
  expect(await wizard().state(workspaceId, user.id)).toBeNull();
});

test("finishing saves the role, clears the wizard, then starts the assistant and names its DM", async () => {
  const { user, workspaceId } = await signedUp("finish");
  const started: { workspaceId: string; userId: string }[] = [];
  let pendingAtStart: Date | null | undefined;
  const result = await new OnboardingWizard(db, {
    online: async () => [],
    canRun: async () => true,
    startAssistant: async (w, u) => {
      pendingAtStart = await pendingOf(w, u);
      started.push({ workspaceId: w, userId: u });
      const assistant = await new WorkspaceAssistants(db).ensure(w, u);
      // What a real Start leaves behind: the assistant is no longer one that has never run.
      await db.agent.update({
        where: { id: assistant.agentId },
        data: { controlState: { phase: "completed" } },
      });
      return assistant;
    },
  }).complete(workspaceId, user.id, { role: "designer" });
  expect(pendingAtStart).toBeNull();
  expect(started).toEqual([{ workspaceId, userId: user.id }]);
  expect(await pendingOf(workspaceId, user.id)).toBeNull();
  expect((await db.userPreference.findUniqueOrThrow({ where: { userId: user.id } })).role).toBe(
    "designer",
  );
  const assistant = await new WorkspaceAssistants(db).ensure(workspaceId, user.id);
  expect(result.conversationId).toBe(assistant.conversationId);

  // A second finish (a double click) neither starts it again nor changes the role.
  const again = await wizard({ started }).complete(workspaceId, user.id, { role: "founder" });
  expect(started).toHaveLength(1);
  expect(again.conversationId).toBe(result.conversationId);
  expect((await db.userPreference.findUniqueOrThrow({ where: { userId: user.id } })).role).toBe(
    "designer",
  );
});

test("finishing again after a Start that was lost starts the assistant that never ran", async () => {
  const { user, workspaceId } = await signedUp("retry");
  let failing = true;
  const started: string[] = [];
  const flaky = new OnboardingWizard(db, {
    online: async () => [],
    canRun: async () => true,
    startAssistant: async (w, u) => {
      if (failing) throw new Error("publish failed");
      started.push(u);
      return new WorkspaceAssistants(db).ensure(w, u);
    },
  });
  await expect(flaky.complete(workspaceId, user.id, {})).rejects.toThrow("publish failed");
  expect(await pendingOf(workspaceId, user.id)).toBeNull();
  // The mark is clear but the assistant never ran: the member's retry starts it.
  failing = false;
  const retry = await flaky.complete(workspaceId, user.id, {});
  expect(started).toEqual([user.id]);
  const assistant = await new WorkspaceAssistants(db).ensure(workspaceId, user.id);
  expect(retry.conversationId).toBe(assistant.conversationId);
});

test("skipping completes with no role, and a role outside the closed set is refused", async () => {
  const { user, workspaceId } = await signedUp("skip");
  expect(
    await refusal(wizard().complete(workspaceId, user.id, { role: "astronaut" as never })),
  ).toBe("INVALID_INPUT");
  expect(await pendingOf(workspaceId, user.id)).toBeInstanceOf(Date);
  await wizard().complete(workspaceId, user.id, {});
  expect(await pendingOf(workspaceId, user.id)).toBeNull();
  expect(await db.userPreference.findUnique({ where: { userId: user.id } })).toBeNull();
});

test("the connect step reads only the member's own computers with their status and usable runtimes", async () => {
  const { user, workspaceId } = await signedUp("computers");
  const stranger = await person("computers-other");
  const mine = await localComputer(user.id, workspaceId);
  const theirs = await localComputer(stranger.user.id, workspaceId);
  const theirCloud = await db.computer.create({
    data: {
      ownerId: stranger.user.id,
      machineId: `wiz-cloud-${crypto.randomUUID()}`,
      kind: "cloud",
      cloudSlot: "default",
      workspaces: { create: { workspaceId } },
    },
  });
  const cloud = await db.computer.create({
    data: {
      ownerId: user.id,
      machineId: `wiz-cloud-${crypto.randomUUID()}`,
      kind: "cloud",
      cloudSlot: "default",
      workspaces: { create: { workspaceId } },
    },
  });
  await db.computerRuntime.createMany({
    data: [
      { workspaceId, computerId: mine.id, provider: "codex", version: "1", displayName: "Codex" },
      {
        workspaceId,
        computerId: mine.id,
        provider: "claude-code",
        version: "1",
        displayName: "Claude Code",
        unavailableCode: "start_failed",
      },
      { workspaceId, computerId: theirs.id, provider: "codex", version: "1", displayName: "Codex" },
    ],
  });
  const rows = await wizard({ online: new Set([mine.id]) }).computers(workspaceId, user.id);
  // Another member's default cloud computer is not listed for this member; their local one is
  // listed, not theirs to choose.
  expect(rows.map((row) => row.id).sort()).toEqual([mine.id, theirs.id, cloud.id].sort());
  expect(rows.some((row) => row.id === theirCloud.id)).toBe(false);
  const own = rows.find((row) => row.id === mine.id)!;
  expect(own).toMatchObject({ kind: "local", ownedByCurrentUser: true, online: true });
  expect(own.runtimes).toEqual([
    expect.objectContaining({ provider: "claude-code", unavailableCode: "start_failed" }),
    expect.objectContaining({ provider: "codex", unavailableCode: null }),
  ]);
  expect(rows.find((row) => row.id === theirs.id)).toMatchObject({
    ownedByCurrentUser: false,
    online: false,
    runtimes: [],
  });
  expect(rows.find((row) => row.id === cloud.id)).toMatchObject({
    kind: "cloud",
    cloudSlot: "default",
    online: false,
  });
});

test("the wizard binds the assistant only while pending, and refuses the runtimes it cannot offer", async () => {
  const { user, workspaceId } = await signedUp("bind");
  const computer = await localComputer(user.id, workspaceId);
  const assistant = (await wizard().state(workspaceId, user.id))!.assistant;
  const choice = {
    computerId: computer.id,
    provider: "claude-code",
    model: "sonnet",
    modelProvider: "",
    reasoning: "",
  } as const;
  await wizard().configureAssistant(workspaceId, user.id, choice);
  const agent = await db.agent.findUniqueOrThrow({ where: { id: assistant.agentId } });
  expect(agent.computerId).toBe(computer.id);
  expect(agent.runtimeConfig).toMatchObject({ runtime: "claude-code", model: "sonnet" });

  expect(
    await refusal(
      wizard({ canRun: false }).configureAssistant(workspaceId, user.id, {
        ...choice,
        provider: "codex",
      }),
    ),
  ).toBe("agent-runtime-unavailable");
  expect(
    await refusal(
      wizard().configureAssistant(workspaceId, user.id, { ...choice, provider: "coforge" }),
    ),
  ).toBe("agent-api-key-required");
  await wizard().complete(workspaceId, user.id, {});
  expect(await refusal(wizard().configureAssistant(workspaceId, user.id, choice))).toBe(
    "onboarding-not-pending",
  );
});

test("a device sign-in the member approved lately counts, even after the daemon took its token", async () => {
  const { user } = await person("approval");
  const stranger = await person("approval-other");
  const grant = (userId: string, status: string, approvedAt: Date | null) =>
    db.deviceAuthorization.create({
      data: {
        deviceCodeHash: crypto.randomUUID(),
        userCodeHash: crypto.randomUUID(),
        expiresAt: new Date(Date.now() + 600_000),
        userId,
        status,
        approvedAt,
      },
    });
  const now = new Date();
  expect(await wizard().deviceApproved(user.id, now)).toBe(false);
  await grant(stranger.user.id, "approved", now);
  await grant(user.id, "approved", new Date(now.getTime() - 3 * 60 * 60_000));
  await grant(user.id, "pending", null);
  await grant(user.id, "denied", now);
  expect(await wizard().deviceApproved(user.id, now)).toBe(false);
  // The daemon's first poll consumes the grant; the member still approved it just now.
  const consumed = await grant(user.id, "consumed", new Date(now.getTime() - 60_000));
  expect(await wizard().deviceApproved(user.id, now)).toBe(true);
  await db.deviceAuthorization.update({ where: { id: consumed.id }, data: { status: "approved" } });
  expect(await wizard().deviceApproved(user.id, now)).toBe(true);
});

afterAll(async () => {
  await db.deviceAuthorization.deleteMany({ where: { userId: { in: created.users } } });
  await db.workspace.deleteMany({ where: { id: { in: created.workspaces } } }).catch(() => {});
  await db.computer.deleteMany({ where: { ownerId: { in: created.users } } }).catch(() => {});
  await db.user.deleteMany({ where: { id: { in: created.users } } }).catch(() => {});
  await db.$disconnect();
});
