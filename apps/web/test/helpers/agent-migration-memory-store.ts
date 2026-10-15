import {
  isFinishedAgentMigration,
  type AgentMigrationRecord,
  type AgentMigrationStore,
} from "#src/server/agent-migrations/agent-migrations.server";

/**
 * An in-memory store that keeps the store's contract: a transition applies only at the revision
 * it names, and a move only while the Agent is still on the source. Compare-and-set, the single
 * active migration and the atomic switch against PostgreSQL are covered by
 * `agent-migration-repository.integration.test.ts`.
 */
export function memoryStore(
  placement: { computerId: string | null } | null = { computerId: "computer-a" },
) {
  const rows = new Map<string, AgentMigrationRecord>();
  const manifests = new Map<string, unknown>();
  const agentComputer = { value: placement?.computerId ?? null };
  const liveComputers = new Set(["computer-a", "computer-b"]);
  const store: AgentMigrationStore = {
    agentPlacement: async () => (placement ? { computerId: agentComputer.value } : null),
    workspaceHasComputer: async (_workspace, computerId) => liveComputers.has(computerId),
    create: async (input) => {
      const active = [...rows.values()].some(
        (row) => row.agentId === input.agentId && !isFinishedAgentMigration(row.state),
      );
      if (active) return "active_exists";
      const row: AgentMigrationRecord = {
        id: crypto.randomUUID(),
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        sourceComputerId: input.sourceComputerId,
        targetComputerId: input.targetComputerId,
        state: "requested",
        revision: 0,
        generation: 1,
        switchedAt: null,
        errorCode: null,
      };
      rows.set(row.id, row);
      return row;
    },
    find: async (id) => rows.get(id) ?? null,
    activeFor: async (workspaceId, computerId) =>
      [...rows.values()].filter(
        (row) =>
          row.workspaceId === workspaceId &&
          !isFinishedAgentMigration(row.state) &&
          (row.sourceComputerId === computerId || row.targetComputerId === computerId),
      ),
    manifest: async (id) => manifests.get(id) ?? null,
    transition: async ({ id, expectedRevision, to, error, move, manifest }) => {
      const row = rows.get(id);
      if (!row || row.revision !== expectedRevision) return "stale_revision";
      if (move && agentComputer.value !== move.fromComputerId) return "agent_moved";
      if (move && !liveComputers.has(move.toComputerId)) return "target_unavailable";
      const updated = {
        ...row,
        state: to,
        revision: row.revision + 1,
        ...(to === "switched" ? { switchedAt: new Date() } : {}),
        ...(error ? { errorCode: error.code } : {}),
      };
      rows.set(id, updated);
      if (manifest !== undefined) manifests.set(id, manifest);
      if (move) agentComputer.value = move.toComputerId;
      return updated;
    },
  };
  return { store, rows, manifests, agentComputer, liveComputers };
}
