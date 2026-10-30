import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { AgentDeletion } from "#src/server/agents/agent-deletion.server";
import { PrismaAgentDeletionStore } from "#src/server/db/repositories/agent-deletion.repositories.server";
import { PrismaAgentRepository } from "#src/server/db/repositories/agent.repositories.server";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { enrollGeneralChannel } from "#src/server/conversations/general-channel.server";

/** The Agent deletion suites run against local PostgreSQL, and are skipped without it. */
export const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

/** A Workspace with an owner, a member and an Agent on a Computer, enrolled in #general. */
export async function setup() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({
    data: { displayName: `del-owner-${suffix}`, username: `del-owner-${suffix}` },
  });
  const member = await db.user.create({
    data: { displayName: `del-member-${suffix}`, username: `del-member-${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `del-${suffix}`,
      name: "Agent deletion",
      members: {
        create: [
          { userId: owner.id, role: "owner" },
          { userId: member.id, role: "member" },
        ],
      },
    },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      name: `doomed-${suffix}`,
      displayName: "Doomed",
      ownerId: owner.id,
      runtimeConfig: {
        runtime: "pi",
        provider: { kind: "default" },
        model: "",
        modelProvider: "",
        reasoning: "",
      },
    },
  });
  await enrollGeneralChannel(db, workspace.id);
  // An Agent joins #general muted; these tests need the ordinary #general Task delivery.
  await new PublicChannels(db).setAgentMuted(workspace.id, agent.id, "#general", false);
  // A Computer assignment, so the delete's runtime Stop is genuinely attempted.
  const computer = await db.computer.create({
    data: {
      ownerId: owner.id,
      machineId: crypto.randomUUID(),
      name: `box-${suffix}`,
      displayName: "Box",
    },
  });
  await db.workspaceComputer.create({
    data: { workspaceId: workspace.id, computerId: computer.id },
  });
  await db.agent.update({ where: { id: agent.id }, data: { computerId: computer.id } });
  return {
    db,
    workspace,
    owner,
    member,
    agent: { ...agent, computerId: computer.id },
    computer,
  };
}

/** The real composition, with the runtime stop captured instead of published. */
export function deletionFor(db: PrismaClient, stops: string[]) {
  return new AgentDeletion(
    new PrismaAgentRepository(db),
    new PrismaAgentDeletionStore(db),
    {
      stop: async (intent) => {
        stops.push(intent.agentId);
      },
    },
    { run: async (_agentId, callback) => callback() },
  );
}
