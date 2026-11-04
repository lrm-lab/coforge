import { expect, test } from "bun:test";
import {
  authenticateAgentApiKey,
  createAgentApiKey,
  findAgentApiKey,
  hashAgentApiKey,
  isAgentApiKeyBoundToComputer,
  type AgentApiKeyMintInput,
  type AgentApiKeyRecord,
  type AgentApiKeyRepository,
} from "#src/server/agents/agent-api-key.server";

class MemoryAgentApiKeys implements AgentApiKeyRepository {
  records = new Map<string, AgentApiKeyRecord>();
  /** Insertion order stands in for the (createdAt, uuid(7) id) ordering the Prisma row has. */
  #sequence = 0;
  #order = new Map<string, number>();

  #active(record: AgentApiKeyRecord) {
    return !record.revokedAt && !record.disabledAt;
  }

  async rotate(record: AgentApiKeyMintInput) {
    // The Prisma client generates the id and createdAt from the schema defaults when the mint
    // path omits them; this fake reproduces that so lookups behave like real rows.
    const stored: AgentApiKeyRecord = {
      id: crypto.randomUUID(),
      createdAt: new Date(),
      ...record,
    };
    const scoped = (current: AgentApiKeyRecord) =>
      current.agentId === record.agentId &&
      current.workspaceId === record.workspaceId &&
      current.ownerId === record.ownerId &&
      this.#active(current);
    let newest: AgentApiKeyRecord | undefined;
    for (const current of this.records.values())
      if (
        scoped(current) &&
        (!newest || this.#order.get(current.id)! > this.#order.get(newest.id)!)
      )
        newest = current;
    for (const current of this.records.values())
      if (scoped(current) && current.id !== newest?.id) current.revokedAt = new Date();
    this.#order.set(stored.id, this.#sequence++);
    this.records.set(record.apiKeyHash, stored);
  }

  async findByHash(hash: string) {
    return this.records.get(hash);
  }

  async revokeOlderKeys(record: AgentApiKeyRecord) {
    const mine = this.#order.get(record.id)!;
    for (const current of this.records.values())
      if (
        current.agentId === record.agentId &&
        current.workspaceId === record.workspaceId &&
        this.#active(current) &&
        this.#order.get(current.id)! < mine
      )
        current.revokedAt = new Date();
  }

  async revoke(id: string) {
    for (const record of this.records.values()) if (record.id === id) record.revokedAt = new Date();
  }
}

test("Agent API key is returned once, stored only as a computer-bound hash, and revoked", async () => {
  const repository = new MemoryAgentApiKeys();
  const apiKey = await createAgentApiKey({
    agentId: "agent-a",
    workspaceId: "workspace-a",
    ownerId: "owner-a",
    computerId: "computer-a",
    repository,
  });

  expect(apiKey).toMatch(/^sk_agent_[A-Za-z0-9_-]{43}$/);
  expect([...repository.records.keys()]).toEqual([hashAgentApiKey(apiKey)]);
  expect(JSON.stringify([...repository.records.values()])).not.toContain(apiKey);
  const principal = await authenticateAgentApiKey(apiKey, repository);
  expect(principal).toMatchObject({
    agentId: "agent-a",
    workspaceId: "workspace-a",
    ownerId: "owner-a",
    computerId: "computer-a",
  });

  await repository.revoke(principal.id);
  await expect(authenticateAgentApiKey(apiKey, repository)).rejects.toThrow(
    "invalid Agent API key",
  );
  expect(await findAgentApiKey(apiKey, repository)).toMatchObject({
    id: principal.id,
    revokedAt: expect.any(Date),
  });
  await repository.revoke(principal.id);
  expect((await findAgentApiKey(apiKey, repository)).id).toBe(principal.id);
});

/** The bug this fixes: every mint revoked the running process's key. The previous key now stays
 * valid until the new key's first successful authentication. */
test("a second mint keeps the previous key until the new one first authenticates", async () => {
  const repository = new MemoryAgentApiKeys();
  const input = {
    agentId: "agent-a",
    workspaceId: "workspace-a",
    ownerId: "owner-a",
    computerId: "computer-a",
    repository,
  };
  const oldApiKey = await createAgentApiKey(input);
  const newApiKey = await createAgentApiKey(input);

  await expect(authenticateAgentApiKey(oldApiKey, repository)).resolves.toMatchObject({
    computerId: "computer-a",
  });
  await expect(authenticateAgentApiKey(newApiKey, repository)).resolves.toMatchObject({
    computerId: "computer-a",
  });
  // The new key's first successful authentication retired the previous one.
  await expect(authenticateAgentApiKey(oldApiKey, repository)).rejects.toThrow(
    "invalid Agent API key",
  );
});

test("a third mint keeps only the two newest keys valid", async () => {
  const repository = new MemoryAgentApiKeys();
  const input = {
    agentId: "agent-a",
    workspaceId: "workspace-a",
    ownerId: "owner-a",
    computerId: "computer-a",
    repository,
  };
  const first = await createAgentApiKey(input);
  const second = await createAgentApiKey(input);
  const third = await createAgentApiKey(input);

  await expect(authenticateAgentApiKey(first, repository)).rejects.toThrow("invalid Agent API key");
  await expect(authenticateAgentApiKey(second, repository)).resolves.toMatchObject({
    computerId: "computer-a",
  });
  await expect(authenticateAgentApiKey(third, repository)).resolves.toMatchObject({
    computerId: "computer-a",
  });
});

test("another Computer cannot send with or revoke an Agent API key", async () => {
  const repository = new MemoryAgentApiKeys();
  const apiKey = await createAgentApiKey({
    agentId: "agent-a",
    workspaceId: "workspace-a",
    ownerId: "owner-a",
    computerId: "computer-a",
    repository,
  });
  const record = await authenticateAgentApiKey(apiKey, repository);

  expect(
    isAgentApiKeyBoundToComputer(record, {
      workspaceId: "workspace-a",
      computerId: "computer-b",
    }),
  ).toBeFalse();
});
