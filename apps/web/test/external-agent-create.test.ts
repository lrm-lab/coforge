import { expect, test } from "bun:test";
import {
  createExternalAgent,
  EXTERNAL_AGENT_RUNTIME_CONFIG,
} from "#src/server/agents/external-agent-create.server";
import { parseAgentRuntimeConfig } from "#src/server/agents/agent-runtime-config.server";
import { ManageAgents } from "#src/server/agents/manage-agents.server";
import type { AgentCreateInput } from "#src/server/db/repositories/agent.repositories.server";
import { createExternalAgentInputSchema } from "#src/features/agents/agent.schemas";

function repository() {
  const created: AgentCreateInput[] = [];
  return {
    created,
    create: async (input: AgentCreateInput) => {
      created.push(input);
      return {
        ...input,
        id: "agent-1",
        createdAt: new Date(),
        runtimeConfig: input.runtimeConfig,
      };
    },
  };
}

const OWNER = { userId: "user-1", workspaceId: "ws-1", role: "owner" as const };
const INPUT = { hosting: "external" as const, name: " Scout ", description: " finds things " };

test("an external Agent is created with no Computer, a valid inert runtime config and no introduction", async () => {
  const agents = repository();
  const result = await createExternalAgent(agents, OWNER, INPUT);
  expect(result.startPublished).toBe(false);
  const [input] = agents.created;
  expect(input).toMatchObject({
    name: "scout",
    displayName: "scout",
    description: "finds things",
    hosting: "external",
    ownerId: "user-1",
    workspaceId: "ws-1",
  });
  expect(input).not.toHaveProperty("computerId");
  expect(input).not.toHaveProperty("introductionDueAt");
  expect(() => parseAgentRuntimeConfig(EXTERNAL_AGENT_RUNTIME_CONFIG)).not.toThrow();
});

test("only a Workspace owner or admin may create one", async () => {
  const agents = repository();
  await expect(
    createExternalAgent(agents, { ...OWNER, role: "member" }, INPUT),
  ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  await expect(
    createExternalAgent(agents, { userId: "u", workspaceId: "w" }, INPUT),
  ).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
  expect(agents.created).toEqual([]);
});

test("ManageAgents.create routes hosting external past the runtime and Computer checks", async () => {
  const agents = repository();
  const never = async () => {
    throw new Error("a Computer or runtime was consulted");
  };
  const manage = new ManageAgents(
    agents as never,
    { start: never, stop: never },
    { canRun: never },
    { run: never } as never,
  );
  const result = await manage.create(OWNER, INPUT);
  expect(result.startPublished).toBe(false);
  expect(agents.created).toHaveLength(1);
});

test("the schema accepts external creation without a runtime or Computer", () => {
  expect(
    createExternalAgentInputSchema.parse({ hosting: "external", name: "scout" }),
  ).toMatchObject({
    hosting: "external",
    name: "scout",
    description: "",
    visibility: "public",
  });
  expect(
    createExternalAgentInputSchema.safeParse({ hosting: "managed", name: "scout" }).success,
  ).toBe(false);
});
