import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { readableRuntimeConfig } from "#src/server/agents/agent-runtime-config.server";

export const AGENT_USAGE_SCAN_PREFIX = "agent-usage:";

export type AgentUsageTarget = {
  workspaceId: string;
  computerId: string;
  provider: typeof RUNTIME_PROVIDER.CODEX;
  agentId: string;
  runtimeConfigRevision: number;
  billing?: "provider-api-key";
};

export async function resolveAgentUsageTarget(
  db: Pick<PrismaClient, "agent">,
  input: {
    workspaceId: string;
    agentId: string;
    ownerId?: string;
    computerId?: string;
    runtimeConfigRevision?: number;
  },
): Promise<AgentUsageTarget | undefined> {
  const agent = await db.agent.findFirst({
    where: {
      ...ACTIVE_AGENT_WHERE,
      id: input.agentId,
      workspaceId: input.workspaceId,
      ownerId: input.ownerId,
      computerId: input.computerId ?? { not: null },
      runtimeConfigRevision: input.runtimeConfigRevision,
      hosting: "managed",
    },
    select: { computerId: true, runtimeConfigRevision: true, runtimeConfig: true },
  });
  if (!agent?.computerId) return undefined;
  const config = readableRuntimeConfig(agent.runtimeConfig);
  if (config?.runtime !== RUNTIME_PROVIDER.CODEX) return undefined;
  return {
    workspaceId: input.workspaceId,
    computerId: agent.computerId,
    provider: RUNTIME_PROVIDER.CODEX,
    agentId: input.agentId,
    runtimeConfigRevision: agent.runtimeConfigRevision,
    ...(config.provider.kind === "codex-compatible"
      ? { billing: "provider-api-key" as const }
      : {}),
  };
}
