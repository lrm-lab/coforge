import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { TaskBoard } from "#src/server/tasks/task-board.server";

export async function taskAssignmentFixture(kind: "user" | "agent", role = "member") {
  const connectionString = Bun.env.TASK_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("TASK_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID();
  const people = await Promise.all(
    ["owner", "actor", "peer"].map((name) =>
      db.user.create({
        data: { username: `ta-person-${name}-${suffix}`, displayName: name },
      }),
    ),
  );
  const [owner, user, peer] = people;
  const workspace = await db.workspace.create({
    data: {
      slug: `assignment-${suffix}`,
      name: "Assignment authority",
      members: {
        create: people.map((person) => ({
          userId: person.id,
          role:
            person.id === owner.id
              ? "owner"
              : person.id === user.id && kind === "user"
                ? role
                : "member",
        })),
      },
    },
  });
  const agents = await Promise.all(
    ["actor", "peer"].map((name) =>
      db.agent.create({
        data: {
          workspaceId: workspace.id,
          ownerId: name === "actor" ? owner.id : peer.id,
          name: `ta-agent-${name}-${suffix}`,
          displayName: name,
          role: name === "actor" && kind === "agent" ? role : "member",
          runtimeConfig: {},
        },
      }),
    ),
  );
  const [agent, peerAgent] = agents;
  const conversation = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: `assignment-${suffix.slice(0, 8)}`,
      members: {
        create: [
          ...people.map((person) => ({ userId: person.id })),
          ...agents.map((person) => ({ agentId: person.id })),
        ],
      },
    },
    include: { members: true },
  });
  const actor =
    kind === "user"
      ? { workspaceId: workspace.id, userId: user.id }
      : { workspaceId: workspace.id, agentId: agent.id };
  const member = conversation.members.find((row) =>
    kind === "user" ? row.userId === user.id : row.agentId === agent.id,
  )!;
  return {
    db,
    workspace,
    conversation,
    owner,
    user,
    peer,
    agent,
    peerAgent,
    actor,
    member,
    board: new TaskBoard(db),
    command(actorKind: "user" | "agent" = kind) {
      return {
        ...(actorKind === "user"
          ? { conversationId: conversation.id }
          : { target: `#${conversation.channelName}` }),
        idempotencyKey: crypto.randomUUID(),
      };
    },
    ownerActor: { workspaceId: workspace.id, userId: owner.id },
    peerActor: { workspaceId: workspace.id, agentId: peerAgent.id },
    async close() {
      await db.message.deleteMany({ where: { workspaceId: workspace.id } });
      await db.workspace.delete({ where: { id: workspace.id } });
      await db.user.deleteMany({ where: { id: { in: people.map((person) => person.id) } } });
      await db.$disconnect();
    },
  };
}
