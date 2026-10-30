import {
  RUNTIME_PROVIDER,
  parseRuntimeUnavailableCode,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import { ComputerRuntimeVisibility } from "#src/server/computers/computer-runtime-visibility.server";
import { PrismaComputerRuntimeRepository } from "#src/server/db/repositories/computer-runtime.repositories.server";
import type { AgentRuntimeConfig } from "./agent-runtime-config.server";
import {
  agentRuntimeSelectionRefusal,
  type AgentRuntimeRefusalWithoutModel,
  type AgentRuntimeSelection,
  type AgentRuntimeSelectionRefusal,
} from "./agent-runtime-availability.server";

/**
 * Whether a Computer of the Workspace can run an Agent with this runtime selection for this
 * person: connected to the Workspace, offering the runtime, and holding the model in its catalog.
 * The one check every placement of an Agent on a Computer goes through: create, edit, and move.
 */
export async function computerCanRunAgent(
  db: PrismaClient,
  principal: { workspaceId: string; userId: string },
  computerId: string,
  config: AgentRuntimeSelection,
): Promise<boolean> {
  return (await computerRuntimeRefusal(db, principal, computerId, config)) === null;
}

/** Why `computerCanRunAgent` refuses, or null when the Computer can run the Agent. With
 * `requireModel: false` only the runtime itself is judged: a model catalog is an observation. */
export function computerRuntimeRefusal(
  db: PrismaClient,
  principal: { workspaceId: string; userId: string },
  computerId: string,
  config: AgentRuntimeSelection,
  options: { requireModel: false },
): Promise<AgentRuntimeRefusalWithoutModel | null>;
export function computerRuntimeRefusal(
  db: PrismaClient,
  principal: { workspaceId: string; userId: string },
  computerId: string,
  config: AgentRuntimeSelection,
  options?: { requireModel?: true },
): Promise<AgentRuntimeSelectionRefusal | null>;
export async function computerRuntimeRefusal(
  db: PrismaClient,
  { workspaceId, userId }: { workspaceId: string; userId: string },
  computerId: string,
  config: AgentRuntimeSelection,
  options: { requireModel?: boolean } = {},
): Promise<AgentRuntimeSelectionRefusal | null> {
  const runtimeVisibility = new ComputerRuntimeVisibility(new PrismaComputerRuntimeRepository(db));
  const connection = await db.workspaceComputer.findFirst({
    where: { workspaceId, computerId },
    select: {
      computer: {
        select: {
          runtimes: {
            where: { workspaceId },
            select: { provider: true, unavailableCode: true },
          },
          modelCatalogs: {
            where: {
              workspaceId,
              provider:
                config.provider === RUNTIME_PROVIDER.PI && config.hasApiKey
                  ? { in: [RUNTIME_PROVIDER.PI, RUNTIME_PROVIDER.COFORGE] }
                  : config.provider,
            },
            select: { models: true },
          },
        },
      },
    },
  });
  const providers = new Set<typeof config.provider>();
  if (await runtimeVisibility.canSelect({ workspaceId, userId }, computerId, config.provider))
    providers.add(config.provider);
  if (
    config.provider === RUNTIME_PROVIDER.COFORGE &&
    (await runtimeVisibility.canSelect({ workspaceId, userId }, computerId, RUNTIME_PROVIDER.PI))
  )
    providers.add(RUNTIME_PROVIDER.PI);
  const models = connection?.computer.modelCatalogs.flatMap((catalog) =>
    Array.isArray(catalog.models) ? catalog.models : [],
  );
  const facts = {
    connected: Boolean(connection),
    reported: new Set(
      connection?.computer.runtimes.map(({ provider }) => provider as RuntimeProvider),
    ),
    // Normalized exactly as the repository reads it, so an unknown stored code stays usable here
    // too instead of refusing a runtime the picker offers.
    unusable: new Set(
      connection?.computer.runtimes.flatMap(({ provider, unavailableCode }) =>
        parseRuntimeUnavailableCode(unavailableCode) ? [provider as RuntimeProvider] : [],
      ),
    ),
    providers,
    models: models ?? [],
  };
  return options.requireModel === false
    ? agentRuntimeSelectionRefusal(config, facts, { requireModel: false })
    : agentRuntimeSelectionRefusal(config, facts);
}

/** An Agent's stored runtime configuration, as the selection `computerCanRunAgent` checks. */
export function storedRuntimeSelection(config: AgentRuntimeConfig): AgentRuntimeSelection {
  return {
    provider: config.runtime,
    model: config.model,
    modelProvider: config.modelProvider,
    reasoning: config.reasoning,
    hasApiKey: config.provider.kind === "coforge" && Boolean(config.provider.apiKey),
    fastMode: config.fastMode === true,
  };
}
