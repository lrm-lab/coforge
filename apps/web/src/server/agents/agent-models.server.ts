import type { CodeAgentModelMetadata } from "@lrm/coforge-sdk/internal";
import { agentModelName } from "#src/features/agents/agent-model-name";
import { modelMetadata } from "#src/features/computers/computer-model-metadata";
import type { PrismaClient } from "#src/generated/prisma/client";
import { ACTIVE_AGENT_WHERE } from "./active-agent.server";
import { parseAgentRuntimeConfig } from "./agent-runtime-config.server";
import { visibleAgentWhere, type AgentVisibilityViewer } from "./agent-visibility.server";

/**
 * The configured model of every live Agent in the Workspace that `viewer` may see, by Agent id,
 * for the model shown beside an Agent's name in chat. Wider than `listAgents` (the viewer's own
 * roster): a channel shows messages from other members' public Agents too. Every such Agent has an
 * entry, so the browser can tell an Agent it has not heard of (read again) from one left on its
 * runtime's default model, or whose stored config cannot be read (`""`, nothing to show).
 * A model goes by the name its Computer's catalog gives it (`agentModelName`); `modelIds` keeps
 * the stored id each name was resolved from.
 * `readAt` is the server's clock, the one message times come from, so the browser compares a
 * message with the list without trusting its own clock.
 */
export async function listVisibleAgentModels(
  db: Pick<PrismaClient, "agent" | "computerModelCatalog">,
  workspaceId: string,
  viewer: AgentVisibilityViewer,
  now: () => number = Date.now,
): Promise<{
  readAt: number;
  models: Record<string, string>;
  modelIds: Record<string, string>;
}> {
  // Taken before the read: the list covers every Agent that existed by `readAt`.
  const readAt = now();
  const rows = await db.agent.findMany({
    where: { workspaceId, ...ACTIVE_AGENT_WHERE, ...visibleAgentWhere(viewer) },
    select: { id: true, computerId: true, runtimeConfig: true },
  });
  const agents = rows.map((row) => ({ ...row, choice: modelChoice(row.runtimeConfig) }));
  const computerIds = [...new Set(agents.flatMap((agent) => agent.computerId ?? []))];
  const runtimes = [...new Set(agents.flatMap((agent) => agent.choice?.runtime ?? []))];
  // Only the catalogs these Agents run on, each parsed once however many of its Agents are listed.
  const catalogs = new Map<string, { provider: string; models: CodeAgentModelMetadata[] }[]>();
  if (computerIds.length)
    for (const catalog of await db.computerModelCatalog.findMany({
      where: { workspaceId, computerId: { in: computerIds }, provider: { in: runtimes } },
      select: { computerId: true, provider: true, models: true },
    })) {
      const listed = catalogs.get(catalog.computerId) ?? [];
      listed.push({ provider: catalog.provider, models: modelMetadata(catalog.models) ?? [] });
      catalogs.set(catalog.computerId, listed);
    }
  const models: Record<string, string> = {};
  const modelIds: Record<string, string> = {};
  for (const { id, computerId, choice } of agents) {
    models[id] = choice
      ? agentModelName(computerId ? catalogs.get(computerId) : undefined, choice)
      : "";
    modelIds[id] = choice?.model ?? "";
  }
  return { readAt, models, modelIds };
}

/** The model an Agent is configured with, or `undefined` when its stored config cannot be read. */
function modelChoice(runtimeConfig: unknown) {
  try {
    const { runtime, model, modelProvider } = parseAgentRuntimeConfig(runtimeConfig);
    return { runtime, model: model.trim(), modelProvider };
  } catch {
    return undefined;
  }
}
