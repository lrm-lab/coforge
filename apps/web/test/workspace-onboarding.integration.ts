import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { agentDirectKey } from "#src/features/conversations/direct-key";
import { WORKSPACE_ASSISTANT_KIND } from "#src/features/agents/agent-system-kind";
import { WorkspaceAssistants } from "#src/server/agents/workspace-assistants.server";
import { enrollGeneralChannel } from "#src/server/conversations/general-channel.server";
import {
  createAgentIntroduction,
  PrismaAgentIntroductionStore,
} from "#src/server/db/repositories/agent-introduction.repositories.server";
import { PrismaAgentControlStore } from "#src/server/db/repositories/agent-control.repositories.server";
import { PrismaAgentDeletionStore } from "#src/server/db/repositories/agent-deletion.repositories.server";
import { PrismaChangeAgentVisibilityStore } from "#src/server/db/repositories/agent-visibility-change.repositories.server";
import { PrismaWorkspaceJoinLinkStore } from "#src/server/workspaces/join-links-store.server";
import {
  loadWorkspaceOnboarding,
  saveWorkspaceOnboarding,
} from "#src/server/workspaces/workspace-onboarding.server";

/**
 * A Workspace's new-member onboarding settings against local PostgreSQL: who may save them and
 * which Agents they may name, the table's check and the fallback when the chosen Agent goes away,
 * the welcome request a join writes in `agent` mode, and the new-Agent greeting fact a Start reads.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

const RUNTIME_CONFIG = {
  runtime: "pi" as const,
  provider: { kind: "default" as const },
  model: "",
  modelProvider: "",
  reasoning: "",
};

describe.skipIf(!connectionString)("workspace onboarding", () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  let workspaceId: string;
  let ownerId: string;
  let computerId: string;
  let agentCount = 0;

  async function newUser(label: string) {
    return db.user.create({
      data: { username: `onb-${label}-${suffix}`, displayName: `Onb ${label}` },
    });
  }

  async function newAgent(extra: Record<string, unknown> = {}) {
    agentCount += 1;
    return db.agent.create({
      data: {
        workspaceId,
        ownerId,
        name: `onb-agent-${agentCount}-${suffix}`,
        displayName: `Agent ${agentCount}`,
        runtimeConfig: RUNTIME_CONFIG,
        computerId,
        ...extra,
      },
    });
  }

  const settings = () =>
    db.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { onboardingMode: true, onboardingAgentId: true, newAgentGreeting: true },
    });

  const reset = () =>
    db.workspace.update({
      where: { id: workspaceId },
      data: { onboardingMode: "assistant", onboardingAgentId: null, newAgentGreeting: false },
    });

  const save = (
    input: { mode: "assistant" | "agent" | "off"; agentId: string | null },
    actorRole: string | undefined = "owner",
    newAgentGreeting = false,
  ) => saveWorkspaceOnboarding(db, { workspaceId, actorRole, newAgentGreeting, ...input });

  /** A newcomer joining by a link of the Workspace, as the join link store admits them. */
  async function join() {
    const user = await newUser(`joiner${++agentCount}`);
    const link = await db.workspaceJoinLink.create({
      data: { workspaceId, createdByUserId: ownerId, token: crypto.randomUUID() },
    });
    const admission = await new PrismaWorkspaceJoinLinkStore(db).admit({
      linkId: link.id,
      userId: user.id,
      now: new Date(),
    });
    expect(admission.status).toBe("admitted");
    return { user, admission };
  }

  const deliveriesTo = (agentId: string) =>
    db.agentMessageDelivery.count({ where: { workspaceId, agentId } });

  beforeAll(async () => {
    const owner = await newUser("owner");
    ownerId = owner.id;
    const workspace = await db.workspace.create({
      data: {
        slug: `onb-${suffix}`,
        name: "Onboarding Co",
        members: { create: { userId: ownerId, role: "owner" } },
      },
    });
    workspaceId = workspace.id;
    await db.$transaction((tx) => enrollGeneralChannel(tx, workspaceId));
    computerId = (
      await db.computer.create({
        data: {
          ownerId,
          machineId: `onb-${suffix}`,
          workspaces: { create: { workspaceId } },
        },
      })
    ).id;
  });

  afterAll(async () => {
    await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    await db.$disconnect();
  });

  test("an owner or admin loads and saves the settings; a member neither", async () => {
    await reset();
    const agent = await newAgent();
    const bot = await newAgent({ systemKind: "app-bot" });
    const assistant = await newAgent({ systemKind: WORKSPACE_ASSISTANT_KIND });
    const hidden = await newAgent({ visibility: "private" });
    const archived = await newAgent({ deletedAt: new Date() });

    const loaded = await loadWorkspaceOnboarding(db, { workspaceId, actorRole: "admin" });
    expect(loaded).toMatchObject({ mode: "assistant", agentId: null, newAgentGreeting: false });
    const offered = loaded!.agents.map((row) => row.id);
    expect(offered).toContain(agent.id);
    for (const excluded of [bot, assistant, hidden, archived])
      expect(offered).not.toContain(excluded.id);
    expect(loaded!.agents.find((row) => row.id === agent.id)).toEqual({
      id: agent.id,
      name: agent.name,
      avatarUrl: expect.any(String),
    });
    expect(await loadWorkspaceOnboarding(db, { workspaceId, actorRole: "member" })).toBeNull();

    const saved = await save({ mode: "agent", agentId: agent.id }, "admin", true);
    expect(saved).toMatchObject({ mode: "agent", agentId: agent.id, newAgentGreeting: true });
    expect(await settings()).toEqual({
      onboardingMode: "agent",
      onboardingAgentId: agent.id,
      newAgentGreeting: true,
    });
    expect(await save({ mode: "off", agentId: null })).toMatchObject({
      mode: "off",
      agentId: null,
      newAgentGreeting: false,
    });
    await expect(save({ mode: "off", agentId: null }, "member")).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
    expect((await settings()).onboardingMode).toBe("off");
  });

  test("a mode and an Agent that disagree, or an Agent that cannot welcome, are invalid input", async () => {
    await reset();
    const agent = await newAgent();
    const memory = await newAgent();
    await db.workspaceMemoryAgent.create({ data: { workspaceId, agentId: memory.id } });
    const other = await db.workspace.create({
      data: { slug: `onb-other-${suffix}`, name: "Other Co" },
    });
    const foreign = await db.agent.create({
      data: {
        workspaceId: other.id,
        ownerId,
        name: `onb-foreign-${suffix}`,
        displayName: "Foreign",
        runtimeConfig: RUNTIME_CONFIG,
      },
    });
    const ineligible = [
      (await newAgent({ systemKind: WORKSPACE_ASSISTANT_KIND })).id,
      (await newAgent({ visibility: "private" })).id,
      (await newAgent({ deletedAt: new Date() })).id,
      memory.id,
      foreign.id,
      crypto.randomUUID(),
    ];
    try {
      await expect(save({ mode: "agent", agentId: null })).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
      await expect(save({ mode: "off", agentId: agent.id })).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
      await expect(save({ mode: "assistant", agentId: agent.id })).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
      for (const agentId of ineligible)
        await expect(save({ mode: "agent", agentId })).rejects.toMatchObject({
          code: "INVALID_INPUT",
        });
      expect((await settings()).onboardingMode).toBe("assistant");
    } finally {
      await db.workspace.delete({ where: { id: other.id } });
    }
  });

  test("the table refuses a row where the mode and the Agent disagree", async () => {
    await reset();
    const agent = await newAgent();
    const write = async (data: {
      onboardingMode: "agent" | "off" | "assistant";
      onboardingAgentId?: string;
    }) => {
      await db.workspace.update({ where: { id: workspaceId }, data });
    };
    await expect(write({ onboardingMode: "agent" })).rejects.toThrow(/workspaces_onboarding_check/);
    for (const onboardingMode of ["off", "assistant"] as const)
      await expect(write({ onboardingMode, onboardingAgentId: agent.id })).rejects.toThrow(
        /workspaces_onboarding_check/,
      );
    expect((await settings()).onboardingMode).toBe("assistant");
  });

  test("hard-deleting the chosen Agent falls the Workspace back to the platform assistant", async () => {
    await reset();
    const agent = await newAgent();
    await save({ mode: "agent", agentId: agent.id }, "owner", true);

    await db.agent.delete({ where: { id: agent.id } });

    expect(await settings()).toEqual({
      onboardingMode: "assistant",
      onboardingAgentId: null,
      newAgentGreeting: true,
    });
  });

  test("archiving the chosen Agent, or making it private, clears the choice in the same transaction", async () => {
    await reset();
    const archived = await newAgent();
    await save({ mode: "agent", agentId: archived.id });
    const outcome = await new PrismaAgentDeletionStore(db).delete({
      agentId: archived.id,
      workspaceId,
      deletedAt: new Date(),
    });
    expect(outcome.outcome).toBe("deleted");
    expect(await settings()).toMatchObject({
      onboardingMode: "assistant",
      onboardingAgentId: null,
    });

    const privatized = await newAgent();
    const visibility = new PrismaChangeAgentVisibilityStore(db);
    await save({ mode: "agent", agentId: privatized.id });
    await visibility.apply({ agentId: privatized.id, workspaceId, visibility: "private" });
    expect(await settings()).toMatchObject({
      onboardingMode: "assistant",
      onboardingAgentId: null,
    });

    // Another Agent going private leaves the choice alone.
    const chosen = await newAgent();
    const other = await newAgent();
    await save({ mode: "agent", agentId: chosen.id });
    await visibility.apply({ agentId: other.id, workspaceId, visibility: "private" });
    expect(await settings()).toMatchObject({
      onboardingMode: "agent",
      onboardingAgentId: chosen.id,
    });
  });

  test("in agent mode a join queues the welcome request for the Agent in its DM with the newcomer", async () => {
    await reset();
    const agent = await newAgent();
    await save({ mode: "agent", agentId: agent.id });

    const { user, admission } = await join();

    const welcome = admission.status === "admitted" ? admission.welcome : undefined;
    expect(welcome).toMatchObject({
      workspaceId,
      agentId: agent.id,
      userId: user.id,
      conversationCreated: true,
      computerId,
      target: `@${user.username}`,
    });
    const conversation = await db.conversation.findUniqueOrThrow({
      where: {
        workspaceId_directKey: { workspaceId, directKey: agentDirectKey(user.id, agent.id) },
      },
      select: {
        id: true,
        members: { where: { leftAt: null }, select: { userId: true, agentId: true } },
        messages: {
          select: {
            senderMemberId: true,
            body: true,
            sequence: true,
            deliveries: { select: { agentId: true, receivedAt: true, sequence: true } },
            systemMessage: { select: { kind: true, params: true } },
          },
        },
      },
    });
    expect(conversation.id).toBe(welcome!.conversationId);
    expect(conversation.members.map((row) => row.userId ?? row.agentId).sort()).toEqual(
      [user.id, agent.id].sort(),
    );
    const [message] = conversation.messages;
    expect(conversation.messages).toHaveLength(1);
    expect(message).toMatchObject({
      senderMemberId: null,
      deliveries: [{ agentId: agent.id, receivedAt: null, sequence: message!.sequence }],
      systemMessage: { kind: "member.welcome_requested" },
    });
    expect(message!.body).toContain(`@${agent.name}`);
    expect(message!.body).toContain("Onboarding Co");
    expect(message!.systemMessage!.params).toMatchObject({
      newcomer: { handle: user.username },
      agent: { handle: agent.name },
    });
    expect(welcome!.message.deliveryId).toBeString();
  });

  test("a stopped Agent still gets the request, queued with nothing to push", async () => {
    await reset();
    const agent = await newAgent({ stoppedAt: new Date() });
    await save({ mode: "agent", agentId: agent.id });

    const { admission } = await join();

    const welcome = admission.status === "admitted" ? admission.welcome : undefined;
    expect(welcome?.computerId).toBeNull();
    expect(await deliveriesTo(agent.id)).toBe(1);
  });

  test("a member who joins again keeps their DM and gets one more request", async () => {
    await reset();
    const agent = await newAgent();
    await save({ mode: "agent", agentId: agent.id });
    const before = await deliveriesTo(agent.id);
    const { user } = await join();
    await db.workspaceMembership.delete({
      where: { workspaceId_userId: { workspaceId, userId: user.id } },
    });
    await db.conversationMember.updateMany({
      where: { workspaceId, userId: user.id, conversation: { directKey: { not: null } } },
      data: { leftAt: new Date() },
    });
    const link = await db.workspaceJoinLink.create({
      data: { workspaceId, createdByUserId: ownerId, token: crypto.randomUUID() },
    });

    const again = await new PrismaWorkspaceJoinLinkStore(db).admit({
      linkId: link.id,
      userId: user.id,
      now: new Date(),
    });

    expect(again.status === "admitted" && again.welcome?.conversationCreated).toBe(false);
    expect(await deliveriesTo(agent.id)).toBe(before + 2);
    expect(
      await db.conversation.count({
        where: { workspaceId, directKey: agentDirectKey(user.id, agent.id) },
      }),
    ).toBe(1);
    const seat = await db.conversationMember.findFirstOrThrow({
      where: { workspaceId, userId: user.id, conversation: { directKey: { not: null } } },
    });
    expect(seat.leftAt).toBeNull();
  });

  test("in assistant or off mode a join writes no request to anyone", async () => {
    await reset();
    const agent = await newAgent();
    for (const mode of ["assistant", "off"] as const) {
      await save({ mode, agentId: null });
      const before = await db.agentMessageDelivery.count({ where: { workspaceId } });

      const { user, admission } = await join();

      expect(admission.status === "admitted" && admission.welcome).toBeFalsy();
      expect(await db.agentMessageDelivery.count({ where: { workspaceId } })).toBe(before);
      expect(await deliveriesTo(agent.id)).toBe(0);
      expect(
        await db.conversation.count({
          where: { workspaceId, directKey: agentDirectKey(user.id, agent.id) },
        }),
      ).toBe(0);
    }
  });

  /** The platform assistant's Start prompt for a member who joined, as its Start builds it. */
  async function assistantPrompt(userId: string) {
    const session = await new WorkspaceAssistants(db).ensure(workspaceId, userId);
    const assistant = await db.agent.findUniqueOrThrow({
      where: { id: session.agentId },
      include: { owner: { select: { username: true } } },
    });
    return createAgentIntroduction(db).promptFor(
      { ...assistant, ownerUsername: assistant.owner.username },
      new Date(),
    );
  }

  test("the platform assistant welcomes a member only if the mode at their join was assistant", async () => {
    await reset();
    const agent = await newAgent();

    const joinedUnder = async (mode: "assistant" | "agent" | "off") => {
      await save(mode === "agent" ? { mode, agentId: agent.id } : { mode, agentId: null });
      return (await join()).user;
    };
    const underOff = await joinedUnder("off");
    const underAgent = await joinedUnder("agent");
    const underAssistant = await joinedUnder("assistant");
    const recorded = await db.workspaceMembership.findMany({
      where: { workspaceId, userId: { in: [underOff.id, underAgent.id, underAssistant.id] } },
      select: { userId: true, assistantWelcome: true },
    });
    expect(Object.fromEntries(recorded.map((row) => [row.userId, row.assistantWelcome]))).toEqual({
      [underOff.id]: false,
      [underAgent.id]: false,
      [underAssistant.id]: true,
    });

    // The decision was made at the join: switching the mode later changes none of them.
    await save({ mode: "assistant", agentId: null });
    expect(await assistantPrompt(underOff.id)).toBeUndefined();
    expect(await assistantPrompt(underAgent.id)).toBeUndefined();
    expect(await assistantPrompt(underAssistant.id)).toContain("platform assistant");
    await save({ mode: "off", agentId: null });
    expect(await assistantPrompt(underAssistant.id)).toContain("platform assistant");
    expect(await assistantPrompt(underOff.id)).toBeUndefined();

    // A Workspace's creator, and anyone from before the column, are still welcomed.
    expect(await assistantPrompt(ownerId)).toContain("platform assistant");
  });

  test("a Start reads the new-Agent greeting where #general is shown", async () => {
    await reset();
    const agent = await newAgent({ introductionDueAt: new Date() });
    const control = new PrismaAgentControlStore(db);
    const introductions = new PrismaAgentIntroductionStore(db);
    const facts = async () => {
      const subject = (await control.get(agent.id))!;
      return { ...subject, ...(await introductions.workspaceFacts(subject)) };
    };

    expect(await facts()).toMatchObject({ greetGeneral: false });

    await save({ mode: "off", agentId: null }, "owner", true);
    expect(await facts()).toMatchObject({ greetGeneral: true });
    const owner = await db.user.findUniqueOrThrow({ where: { id: ownerId } });
    const greeting = await createAgentIntroduction(db).promptFor(
      { ...(await facts()), ownerUsername: owner.username },
      new Date(),
    );
    expect(greeting).toContain("--target '#general'");

    await db.conversation.update({
      where: { workspaceId_channelName: { workspaceId, channelName: "general" } },
      data: { hiddenFromWorkspaceAt: new Date() },
    });
    expect((await facts()).greetGeneral).toBe(false);
    await db.conversation.update({
      where: { workspaceId_channelName: { workspaceId, channelName: "general" } },
      data: { hiddenFromWorkspaceAt: null },
    });
    expect((await facts()).greetGeneral).toBe(true);

    await db.agent.update({ where: { id: agent.id }, data: { visibility: "private" } });
    expect((await facts()).greetGeneral).toBe(false);
    await db.agent.update({ where: { id: agent.id }, data: { visibility: "public" } });

    await db.workspace.update({ where: { id: workspaceId }, data: { newAgentGreeting: false } });
    expect((await facts()).greetGeneral).toBe(false);
  });
});
