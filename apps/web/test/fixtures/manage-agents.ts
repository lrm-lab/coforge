import { ControlFenceLostError } from "#src/server/agents/agent-config-plan.server";
import { ManageAgents } from "#src/server/agents/manage-agents.server";
import type {
  AgentRecord,
  AgentRepository,
} from "#src/server/db/repositories/agent.repositories.server";
import { configApplyOf, type ConfigApplyOptions } from "./config-push";

export function fixture(options?: {
  publishFails?: boolean;
  stopFails?: boolean;
  unavailable?: boolean;
  encryptionFails?: boolean;
  createFails?: boolean;
  /** The push wired in: `supported: false` is a Daemon without the capability; absent wires none. */
  push?: ConfigApplyOptions;
}) {
  const records: AgentRecord[] = [];
  const starts: unknown[] = [];
  const stops: unknown[] = [];
  const controls: string[] = [];
  const selections: Array<{ hasApiKey?: boolean }> = [];
  const fences: unknown[] = [];
  const updates: Array<Parameters<AgentRepository["update"]>[1]> = [];
  const repository: AgentRepository = {
    getById: async (id) => records.find((agent) => agent.id === id),
    listInWorkspace: async (workspaceId) =>
      records.filter((agent) => agent.workspaceId === workspaceId),
    listForComputer: async (workspaceId, computerId) =>
      records.filter(
        (agent) => agent.workspaceId === workspaceId && agent.computerId === computerId,
      ),
    listDeletedForComputer: async () => [],
    listOwnedInWorkspace: async (workspaceId, ownerId) =>
      records.filter((agent) => agent.workspaceId === workspaceId && agent.ownerId === ownerId),
    create: async (input) => {
      if (options?.createFails) throw new Error("database unavailable");
      const record = {
        ...input,
        id: input.id ?? `agent-${records.length + 1}`,
        createdAt: new Date("2026-08-29T00:00:00Z"),
      };
      records.push(record);
      return record;
    },
    update: async (id, input, fence) => {
      if (fence) {
        fences.push(fence);
        if (options?.push?.fenceLost) throw new ControlFenceLostError();
      }
      updates.push(input);
      controls.push("persist");
      const index = records.findIndex((agent) => agent.id === id);
      // The repository raises the revision in the same write as the config.
      records[index] = {
        ...records[index]!,
        ...input,
        ...(input.runtimeConfig
          ? { runtimeConfigRevision: (records[index]!.runtimeConfigRevision ?? 0) + 1 }
          : {}),
      };
      return records[index]!;
    },
  };
  const pushed = options?.push
    ? configApplyOf(() => records[0], {
        ...options.push,
        onPublish: () => controls.push("push"),
      })
    : undefined;
  const agentManagement = new ManageAgents(
    repository,
    {
      start: async (intent, userId) => {
        controls.push("start");
        starts.push({ intent, userId });
        if (options?.publishFails) throw new Error("daemon unavailable");
      },
      stop: async (intent) => {
        controls.push("stop");
        stops.push(intent);
        if (options?.stopFails) throw new Error("stop unavailable");
      },
    },
    {
      canRun: async (_workspaceId, _userId, _computerId, selection) => {
        selections.push(selection);
        return !options?.unavailable;
      },
    },
    { run: async (_agentId, callback) => callback() },
    () => ({
      encrypt: async (_agentId, _providerId, apiKey) => {
        if (options?.encryptionFails) throw new Error("encryption unavailable");
        return { keyId: "v1", ciphertext: `encrypted:${apiKey}`, nonce: "nonce", hint: "••••1234" };
      },
    }),
    pushed?.apply,
  );
  return {
    agentManagement,
    records,
    starts,
    stops,
    controls,
    updates,
    selections,
    fences,
    pushes: pushed?.intents ?? [],
  };
}
