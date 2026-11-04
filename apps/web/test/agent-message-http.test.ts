import { describe, expect, test } from "bun:test";

import {
  createAgentApiKey,
  type AgentApiKeyMintInput,
  type AgentApiKeyRecord,
  type AgentApiKeyRepository,
} from "#src/server/agents/agent-api-key.server";
import { authenticateAgentMessageRequest } from "#src/server/agents/agent-api-http.server";

class MemoryAgentApiKeys implements AgentApiKeyRepository {
  record?: AgentApiKeyRecord;
  async rotate(record: AgentApiKeyMintInput) {
    // Emulate the Prisma client generating the uuid(7) and createdAt defaults at create time.
    this.record = { id: crypto.randomUUID(), createdAt: new Date(), ...record };
  }
  async findByHash(hash: string) {
    return this.record?.apiKeyHash === hash ? this.record : undefined;
  }
  async revokeOlderKeys() {}
  async revoke() {}
}

const request = (agentToken?: string, daemonApiKey?: string, requestId?: string) =>
  new Request("https://server.example/api/agent/v1/messages", {
    method: "POST",
    headers: {
      ...(daemonApiKey ? { authorization: `Bearer ${daemonApiKey}` } : {}),
      ...(agentToken ? { "x-coforge-agent-api-key": `Bearer ${agentToken}` } : {}),
      ...(requestId ? { "x-request-id": requestId } : {}),
    },
  });

describe("Agent message HTTP authentication", () => {
  test("authenticates matching Agent and daemon credentials without a proxy secret", async () => {
    const keys = new MemoryAgentApiKeys();
    const apiKey = await createAgentApiKey({
      agentId: "agent-a",
      workspaceId: "workspace-a",
      ownerId: "owner-a",
      computerId: "computer-a",
      repository: keys,
    });
    const principal = await authenticateAgentMessageRequest(request(apiKey, "daemon-token"), {
      agentApiKeys: keys,
      verifyDaemonApiKey: async (token) => {
        if (token !== "daemon-token") throw new Error("invalid");
        return {
          userId: "owner-a",
          workspaceId: "workspace-a",
          computerId: "computer-a",
        };
      },
      computerBelongsToWorkspace: async () => true,
      agentIsActive: async () => true,
    });
    expect(principal).toEqual({
      userId: "owner-a",
      workspaceId: "workspace-a",
      computerId: "computer-a",
      agentId: "agent-a",
    });
  });

  test("authenticates an Agent owner through another member's assigned Computer", async () => {
    const keys = new MemoryAgentApiKeys();
    const apiKey = await createAgentApiKey({
      agentId: "agent-a",
      workspaceId: "workspace-a",
      ownerId: "agent-owner",
      computerId: "computer-a",
      repository: keys,
    });

    const principal = await authenticateAgentMessageRequest(request(apiKey, "daemon-token"), {
      agentApiKeys: keys,
      verifyDaemonApiKey: async () => ({
        userId: "computer-owner",
        workspaceId: "workspace-a",
        computerId: "computer-a",
      }),
      computerBelongsToWorkspace: async () => true,
      agentIsActive: async () => true,
    });

    expect(principal.userId).toBe("agent-owner");
  });

  test("rejects either missing or invalid credential", async () => {
    const keys = new MemoryAgentApiKeys();
    const apiKey = await createAgentApiKey({
      agentId: "agent-a",
      workspaceId: "workspace-a",
      ownerId: "owner-a",
      computerId: "computer-a",
      repository: keys,
    });
    const dependencies = {
      agentApiKeys: keys,
      verifyDaemonApiKey: async (token: string) => {
        if (token !== "daemon-token") throw new Error("invalid");
        return {
          userId: "owner-a",
          workspaceId: "workspace-a",
          computerId: "computer-a",
        };
      },
      computerBelongsToWorkspace: async () => true,
      agentIsActive: async () => true,
    };
    for (const candidate of [
      request(undefined, "daemon-token"),
      request(apiKey),
      request("sk_agent_invalid", "daemon-token"),
      request(apiKey, "invalid"),
    ])
      await expect(authenticateAgentMessageRequest(candidate, dependencies)).rejects.toThrow();
  });

  test("rejects credentials bound to another Computer, Workspace, or registration", async () => {
    const keys = new MemoryAgentApiKeys();
    const apiKey = await createAgentApiKey({
      agentId: "agent-a",
      workspaceId: "workspace-a",
      ownerId: "owner-a",
      computerId: "computer-a",
      repository: keys,
    });
    for (const daemon of [
      {
        userId: "owner-a",
        workspaceId: "workspace-b",
        computerId: "computer-a",
      },
      {
        userId: "owner-a",
        workspaceId: "workspace-a",
        computerId: "computer-b",
      },
    ])
      await expect(
        authenticateAgentMessageRequest(request(apiKey, "daemon-token"), {
          agentApiKeys: keys,
          verifyDaemonApiKey: async () => daemon,
          computerBelongsToWorkspace: async () => true,
          agentIsActive: async () => true,
        }),
      ).rejects.toThrow();
    await expect(
      authenticateAgentMessageRequest(request(apiKey, "daemon-token"), {
        agentApiKeys: keys,
        verifyDaemonApiKey: async () => ({
          userId: "owner-a",
          workspaceId: "workspace-a",
          computerId: "computer-a",
        }),
        computerBelongsToWorkspace: async () => false,
        agentIsActive: async () => true,
      }),
    ).rejects.toThrow();
  });

  test("rejects credentials whose Agent was deleted", async () => {
    const keys = new MemoryAgentApiKeys();
    const apiKey = await createAgentApiKey({
      agentId: "agent-a",
      workspaceId: "workspace-a",
      ownerId: "owner-a",
      computerId: "computer-a",
      repository: keys,
    });
    const checked: string[] = [];
    await expect(
      authenticateAgentMessageRequest(request(apiKey, "daemon-token"), {
        agentApiKeys: keys,
        verifyDaemonApiKey: async () => ({
          userId: "owner-a",
          workspaceId: "workspace-a",
          computerId: "computer-a",
        }),
        computerBelongsToWorkspace: async () => true,
        agentIsActive: async (workspaceId, agentId) => {
          checked.push(`${workspaceId}/${agentId}`);
          return false;
        },
      }),
    ).rejects.toThrow();
    expect(checked).toEqual(["workspace-a/agent-a"]);
  });

  test("reads independent credential and scope records together, in two waves", async () => {
    const keys = new MemoryAgentApiKeys();
    const apiKey = await createAgentApiKey({
      agentId: "agent-a",
      workspaceId: "workspace-a",
      ownerId: "owner-a",
      computerId: "computer-a",
      repository: keys,
    });
    // Each read records which other reads were still unanswered when it started.
    const pending = new Set<string>();
    const overlaps = new Map<string, string[]>();
    const read = async <T>(name: string, answer: () => Promise<T>) => {
      overlaps.set(name, [...pending]);
      pending.add(name);
      try {
        return await answer();
      } finally {
        pending.delete(name);
      }
    };
    await authenticateAgentMessageRequest(request(apiKey, "daemon-token"), {
      agentApiKeys: {
        ...keys,
        rotate: (record) => keys.rotate(record),
        revoke: () => keys.revoke(),
        revokeOlderKeys: () => keys.revokeOlderKeys(),
        findByHash: (hash) => read("agent key", () => keys.findByHash(hash)),
      },
      verifyDaemonApiKey: () =>
        read("daemon key", async () => ({
          userId: "owner-a",
          workspaceId: "workspace-a",
          computerId: "computer-a",
        })),
      computerBelongsToWorkspace: () => read("computer", async () => true),
      agentIsActive: () => read("agent", async () => true),
    });
    expect(overlaps).toEqual(
      new Map([
        ["agent key", []],
        ["daemon key", ["agent key"]],
        ["computer", []],
        ["agent", ["computer"]],
      ]),
    );
  });

  test("a refused request warns once with the request id and reason, never key material", async () => {
    const keys = new MemoryAgentApiKeys();
    const apiKey = await createAgentApiKey({
      agentId: "agent-a",
      workspaceId: "workspace-a",
      ownerId: "owner-a",
      computerId: "computer-a",
      repository: keys,
    });
    const dependencies = {
      agentApiKeys: keys,
      verifyDaemonApiKey: async () => ({
        userId: "owner-a",
        workspaceId: "workspace-a",
        computerId: "computer-a",
      }),
      computerBelongsToWorkspace: async () => true,
      agentIsActive: async () => true,
    };
    const warnings: Record<string, unknown>[] = [];
    const warn = console.warn;
    console.warn = (line: string) => void warnings.push(JSON.parse(line));
    try {
      await expect(
        authenticateAgentMessageRequest(
          request(`sk_agent_${"z".repeat(43)}`, "daemon-token", "req-not-found"),
          dependencies,
        ),
      ).rejects.toThrow();
      await expect(
        authenticateAgentMessageRequest(request(apiKey, "daemon-token", "req-scope"), {
          ...dependencies,
          computerBelongsToWorkspace: async () => false,
        }),
      ).rejects.toThrow();
      keys.record!.revokedAt = new Date();
      await expect(
        authenticateAgentMessageRequest(
          request(apiKey, "daemon-token", "req-revoked"),
          dependencies,
        ),
      ).rejects.toThrow();
    } finally {
      console.warn = warn;
    }
    expect(warnings).toEqual([
      { event: "agent_http.auth_failed", request_id: "req-not-found", reason: "key_not_found" },
      { event: "agent_http.auth_failed", request_id: "req-scope", reason: "scope_mismatch" },
      { event: "agent_http.auth_failed", request_id: "req-revoked", reason: "key_revoked" },
    ]);
    expect(JSON.stringify(warnings)).not.toContain(apiKey);
  });
});
