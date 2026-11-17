import type {
  ExternalAgentCredentialRepository,
  ExternalCredentialRecord,
  ExternalCredentialRevokeReason,
  ExternalCredentialSummary,
  ExternalCredentialSource,
  ExternalMachine,
  ExternalPresenceRow,
} from "#src/server/agents/external-agent-credentials.server";

type Row = Omit<ExternalCredentialRecord, "agent"> & {
  source: ExternalCredentialSource;
  machine: ExternalMachine | null;
  createdAt: Date;
  revokedReason: string | null;
};

export type MemoryAgent = {
  ownerId: string;
  deletedAt: Date | null;
  stoppedAt: Date | null;
  hosting: string;
  visibility: string;
};

export class MemoryExternalAgentCredentials implements ExternalAgentCredentialRepository {
  rows = new Map<string, Row>();
  touches = 0;
  agents = new Map<string, MemoryAgent>();
  #next = 1;

  addAgent(agentId: string, overrides: Partial<MemoryAgent> = {}) {
    this.agents.set(agentId, {
      ownerId: "owner-1",
      deletedAt: null,
      stoppedAt: null,
      hosting: "external",
      visibility: "public",
      ...overrides,
    });
  }

  async mint(input: Parameters<ExternalAgentCredentialRepository["mint"]>[0]) {
    const agent = this.agents.get(input.agentId);
    if (!agent || agent.deletedAt || agent.stoppedAt)
      return { ok: false as const, reason: "agent_unavailable" as const };
    if (agent.hosting !== "external")
      return { ok: false as const, reason: "agent_not_external" as const };
    const replacing = input.source === "app";
    const live = [...this.rows.values()].filter(
      (row) =>
        row.agentId === input.agentId && !row.revokedAt && !(replacing && row.source === "app"),
    ).length;
    if (live >= input.maxLive) return { ok: false as const, reason: "credential_limit" as const };
    if (replacing)
      for (const row of this.rows.values())
        if (row.agentId === input.agentId && row.source === "app" && !row.revokedAt) {
          row.revokedAt = new Date();
          row.revokedReason = "replaced";
        }
    const id = `credential-${this.#next++}`;
    this.rows.set(input.keyHash, {
      id,
      keyHash: input.keyHash,
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      lastUsedAt: null,
      revokedAt: null,
      revokedReason: null,
      createdAt: new Date(),
      source: input.source,
      machine: input.machine,
    });
    return { ok: true as const, id };
  }

  async findByHash(hash: string) {
    const row = this.rows.get(hash);
    const agent = row && this.agents.get(row.agentId);
    return row && agent ? { ...row, agent } : undefined;
  }

  async touch(id: string, at: Date, notAfter: Date) {
    const row = [...this.rows.values()].find((entry) => entry.id === id);
    if (row && (!row.lastUsedAt || row.lastUsedAt <= notAfter)) {
      row.lastUsedAt = at;
      this.touches++;
    }
  }

  async revoke(id: string, reason: ExternalCredentialRevokeReason, at: Date, agentId?: string) {
    const row = [...this.rows.values()].find((entry) => entry.id === id);
    if (!row || row.revokedAt || (agentId && row.agentId !== agentId)) return false;
    row.revokedAt = at;
    row.revokedReason = reason;
    return true;
  }

  async list(agentId: string): Promise<ExternalCredentialSummary[]> {
    return [...this.rows.values()]
      .filter((row) => row.agentId === agentId)
      .map(({ id, source, machine, createdAt, lastUsedAt, revokedAt, revokedReason }) => ({
        id,
        source,
        machineName: machine?.machineName ?? null,
        hostname: machine?.hostname ?? null,
        os: machine?.os ?? null,
        clientName: machine?.clientName ?? null,
        createdAt,
        lastUsedAt,
        revokedAt,
        revokedReason,
      }));
  }

  async presence(agentIds: readonly string[]): Promise<ExternalPresenceRow[]> {
    return agentIds.flatMap((agentId) => {
      const rows = [...this.rows.values()].filter((row) => row.agentId === agentId);
      if (rows.length === 0) return [];
      const latest = (candidates: Row[]) =>
        candidates.reduce<Date | null>(
          (best, row) =>
            row.lastUsedAt && (!best || row.lastUsedAt > best) ? row.lastUsedAt : best,
          null,
        );
      const live = rows.filter((row) => !row.revokedAt);
      return [
        { agentId, liveCount: live.length, liveLastUsedAt: latest(live), lastUsedAt: latest(rows) },
      ];
    });
  }
}
