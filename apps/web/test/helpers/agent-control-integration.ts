import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { agentControlRevision } from "#src/server/agents/agent-control.server";
import { parseAgentRuntimeConfig } from "#src/server/agents/agent-runtime-config.server";

export function database() {
  const connectionString = Bun.env.AGENT_SESSION_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("AGENT_SESSION_TEST_DATABASE_URL is required (local PostgreSQL)");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

export const storedConfig = {
  runtime: "pi",
  provider: { kind: "default" },
  model: "",
  modelProvider: "",
  reasoning: "",
};

export async function seedWorkspace(db: PrismaClient) {
  const fixture = crypto.randomUUID();
  const owner = await db.user.create({
    data: { displayName: `ctl-${fixture}`, username: `ctl-${fixture}` },
  });
  const workspace = await db.workspace.create({
    data: { slug: `ctl-${fixture}`, name: "Control", members: { create: { userId: owner.id } } },
  });
  const computer = await db.computer.create({
    data: { ownerId: owner.id, machineId: `ctl-${fixture}` },
  });
  await db.workspaceComputer.create({
    data: { workspaceId: workspace.id, computerId: computer.id },
  });
  return { owner, workspace, computer };
}

export function startingState(
  agent: { id: string; workspaceId: string; computerId: string | null },
  requestId: string,
  overrides: Prisma.InputJsonObject = {},
): Prisma.InputJsonObject {
  return {
    version: 1,
    protocolMajor: 1,
    requestId,
    workspaceId: agent.workspaceId,
    computerId: agent.computerId,
    agentId: agent.id,
    provider: "pi",
    epoch: 1,
    action: "start",
    phase: "starting",
    configRevision: agentControlRevision(parseAgentRuntimeConfig(storedConfig)),
    launchId: "launch",
    controlSequence: 0,
    sessionSequence: 0,
    ...overrides,
  };
}

export async function seedAgentOnComputer(
  db: PrismaClient,
  base: Awaited<ReturnType<typeof seedWorkspace>>,
  options: {
    name: string;
    deletedAt?: Date | null;
    state?: (agent: {
      id: string;
      workspaceId: string;
      computerId: string | null;
    }) => Prisma.InputJsonObject;
  },
) {
  const agent = await db.agent.create({
    data: {
      workspaceId: base.workspace.id,
      ownerId: base.owner.id,
      computerId: base.computer.id,
      name: options.name,
      displayName: options.name,
      runtimeConfig: storedConfig,
      deletedAt: options.deletedAt ?? null,
    },
  });
  if (options.state)
    await db.agent.update({
      where: { id: agent.id },
      data: { controlState: options.state(agent) },
    });
  return agent;
}
