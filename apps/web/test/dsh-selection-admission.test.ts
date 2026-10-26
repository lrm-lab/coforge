import { expect, test } from "bun:test";
import { getLocale, overwriteGetLocale } from "#src/paraglide/runtime";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { ManageAgents } from "#src/server/agents/manage-agents.server";
import { createAgentInputSchema, updateAgentInputSchema } from "#src/features/agents/agent.schemas";
import { agentCreateErrorMessage, agentUpdateErrorMessage } from "#src/features/agents/agent-form";
import type {
  AgentRecord,
  AgentRepository,
} from "#src/server/db/repositories/agent.repositories.server";

const principal = { userId: "owner", workspaceId: "workspace", role: "admin" } as const;
const agentId = "6f81050c-6ff3-4f17-b5f8-dc8eed8ea5da";
const reason = "DeepSeek Harness is not available yet";
function fixture() {
  const effects: string[] = [];
  const current: AgentRecord = {
    id: agentId,
    workspaceId: principal.workspaceId,
    ownerId: principal.userId,
    name: "builder",
    displayName: "Builder",
    createdAt: new Date(0),
    computerId: "computer",
    runtimeConfig: {
      runtime: RUNTIME_PROVIDER.CODEX,
      provider: { kind: "default" },
      model: "",
      modelProvider: "",
      reasoning: "",
    },
  };
  const repository: AgentRepository = {
    getById: async () => current,
    listInWorkspace: async () => [],
    listForComputer: async () => [],
    listDeletedForComputer: async () => [],
    listOwnedInWorkspace: async () => [],
    create: async (input) => {
      effects.push("persist");
      return { ...input, id: input.id ?? agentId, createdAt: new Date(0) };
    },
    update: async (_id, input) => {
      effects.push("persist");
      return { ...current, ...input };
    },
  };
  const service = new ManageAgents(
    repository,
    {
      start: async () => {
        effects.push("start");
      },
      stop: async () => {
        effects.push("stop");
      },
    },
    {
      canRun: async () => {
        effects.push("availability");
        return true;
      },
    },
    { run: async (_id, action) => action() },
  );
  return { service, effects };
}
for (const operation of ["create", "update"] as const) {
  test(`DSH cannot bypass rollout admission through Agent ${operation}`, async () => {
    const { service, effects } = fixture();
    const input = {
      name: "builder",
      description: "",
      provider: RUNTIME_PROVIDER.DSH,
      computerId: "computer",
      agentId,
    };
    const error = await service[operation](principal, input).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(error).toMatchObject({
      code: "INVALID_INPUT",
      errorId: "dsh-runtime-not-yet-available",
    });
    expect(effects).toEqual([]);
    const previousLocale = getLocale;
    try {
      for (const [locale, message] of [
        ["en", reason],
        ["zh-CN", "DeepSeek Harness 尚未开放使用"],
      ] as const) {
        overwriteGetLocale(() => locale);
        expect(
          (operation === "create" ? agentCreateErrorMessage : agentUpdateErrorMessage)(error),
        ).toBe(message);
      }
    } finally {
      overwriteGetLocale(previousLocale);
    }
    const parsed = (
      operation === "create" ? createAgentInputSchema : updateAgentInputSchema
    ).safeParse(input);
    expect(parsed.success).toBe(false);
    if (!parsed.success)
      expect(parsed.error.issues).toContainEqual(
        expect.objectContaining({ path: ["provider"], message: "dsh-runtime-not-yet-available" }),
      );
  });
}
