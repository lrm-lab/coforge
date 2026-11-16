import type {
  ExternalAgentCredentialRepository,
  ExternalCredentialRecord,
  ExternalCredentialRevokeReason,
  ExternalCredentialSummary,
  ExternalMachine,
} from "#src/server/agents/external-agent-credentials.server";

type Row = Omit<ExternalCredentialRecord, "agent"> & {
  machine: ExternalMachine;
  createdAt: Date;
  revokedReason: string | null;
};

export type MemoryAgent = {
  ownerId: string;
  deletedAt: Date | null;
  stoppedAt: Date | null;
  hosting: string;
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
      ...overrides,
    });
  }

  async mint(input: Parameters<ExternalAgentCredentialRepository["mint"]>[0]) {
    const agent = this.agents.get(input.agentId);
    if (!agent || agent.deletedAt || agent.stoppedAt)
      return { ok: false as const, reason: "agent_unavailable" as const };
    if (agent.hosting !== "external")
      return { ok: false as const, reason: "agent_not_external" as const };
    const live = [...this.rows.values()].filter(
      (row) => row.agentId === input.agentId && !row.revokedAt,
    ).length;
    if (live >= input.maxLive) return { ok: false as const, reason: "credential_limit" as const };
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

  async revokeAll(agentId: string, reason: ExternalCredentialRevokeReason, at: Date) {
    let count = 0;
    for (const row of this.rows.values())
      if (row.agentId === agentId && !row.revokedAt) {
        row.revokedAt = at;
        row.revokedReason = reason;
        count++;
      }
    return { count };
  }

  async list(agentId: string): Promise<ExternalCredentialSummary[]> {
    return [...this.rows.values()]
      .filter((row) => row.agentId === agentId)
      .map(({ id, machine, createdAt, lastUsedAt, revokedAt, revokedReason }) => ({
        id,
        ...machine,
        createdAt,
        lastUsedAt,
        revokedAt,
        revokedReason,
      }));
  }
}
