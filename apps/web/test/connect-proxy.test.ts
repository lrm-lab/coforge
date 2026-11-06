import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";

import { authenticateCentrifugoConnect } from "#src/server/centrifugo/connect-proxy.server";
import {
  createDaemonApiKeyFactory,
  hashDaemonApiKey,
  type DaemonApiKeyRepository,
} from "#src/server/auth/daemon-api-key.server";

const repository = (): DaemonApiKeyRepository & { token?: string } => {
  const records = new Map<string, any>();
  return {
    async replaceActive(record) {
      records.set(record.apiKeyHash, { ...record, ownerIsMember: true });
    },
    async findByHash(hash) {
      return records.get(hash);
    },
    async markUsed() {},
    token: undefined,
  };
};

const REVOKED_KEY = `dk_${"a".repeat(43)}`;

function refusals() {
  const recorded: { scope: { workspaceId: string; computerId: string }; reason: string }[] = [];
  const cleared: { workspaceId: string; computerId: string }[] = [];
  return {
    recorded,
    cleared,
    connectRefusals: {
      async record(scope: { workspaceId: string; computerId: string }, reason: string) {
        recorded.push({ scope, reason });
      },
      async clear(scope: { workspaceId: string; computerId: string }) {
        cleared.push(scope);
      },
    },
  };
}

function connectRequest(data: unknown): Request {
  return new Request("http://backend", { method: "POST", body: JSON.stringify({ data }) });
}

describe("Centrifugo Connect Proxy", () => {
  test("authenticates a daemon key from connect data and returns its subscriptions", async () => {
    const keys = repository();
    keys.token = await createDaemonApiKeyFactory(keys).create({
      principal: { userId: "user-1" },
      workspaceId: "workspace-1",
      computerId: "computer-1",
    });
    const response = await authenticateCentrifugoConnect(
      new Request("http://backend", {
        method: "POST",
        body: JSON.stringify({ data: { daemonApiKey: keys.token } }),
      }),
      {
        daemonApiKeys: keys,
        computerBelongsToWorkspace: async () => true,
        revocationReason: async () => undefined,
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      result: {
        user: "user-1",
        meta: { workspace_id: "workspace-1", computer_id: "computer-1" },
        subs: { "daemon:workspace-1:computer-1": {} },
      },
    });
  });

  test("refuses a valid key whose Computer is no longer linked to the Workspace for good", async () => {
    const keys = repository();
    keys.token = await createDaemonApiKeyFactory(keys).create({
      principal: { userId: "user-1" },
      workspaceId: "workspace-1",
      computerId: "computer-1",
    });
    const response = await authenticateCentrifugoConnect(
      connectRequest({ daemonApiKey: keys.token }),
      {
        daemonApiKeys: keys,
        computerBelongsToWorkspace: async () => false,
        revocationReason: async () => undefined,
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      disconnect: { code: 4502, reason: "computer_unlinked" },
    });
  });

  test("authenticates an sk_computer key and returns its subscriptions", async () => {
    const keys = repository();
    keys.token = await createDaemonApiKeyFactory(keys).create({
      principal: { userId: "user-1" },
      workspaceId: "workspace-1",
      computerId: "computer-1",
      kind: "computer",
    });
    expect(keys.token).toMatch(/^sk_computer_/);
    const response = await authenticateCentrifugoConnect(
      connectRequest({ daemonApiKey: keys.token }),
      {
        daemonApiKeys: keys,
        computerBelongsToWorkspace: async () => true,
        revocationReason: async () => undefined,
      },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result.user).toBe("user-1");
    expect(body.result.subs).toHaveProperty("daemon:workspace-1:computer-1");
  });

  test("refuses an sk_computer key whose Computer detached, for good", async () => {
    const keys = repository();
    keys.token = await createDaemonApiKeyFactory(keys).create({
      principal: { userId: "user-1" },
      workspaceId: "workspace-1",
      computerId: "computer-1",
      kind: "computer",
    });
    const response = await authenticateCentrifugoConnect(
      connectRequest({ daemonApiKey: keys.token }),
      {
        daemonApiKeys: keys,
        computerBelongsToWorkspace: async () => false,
        revocationReason: async () => undefined,
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      disconnect: { code: 4502, reason: "computer_unlinked" },
    });
  });

  test("refuses a live key whose owner is no longer a member of its Workspace for good", async () => {
    const keys = repository();
    keys.token = await createDaemonApiKeyFactory(keys).create({
      principal: { userId: "user-1" },
      workspaceId: "workspace-1",
      computerId: "computer-1",
    });
    const departed: DaemonApiKeyRepository = {
      ...keys,
      findByHash: async (hash) => {
        const record = await keys.findByHash(hash);
        return record && { ...record, ownerIsMember: false };
      },
    };
    const response = await authenticateCentrifugoConnect(
      connectRequest({ daemonApiKey: keys.token }),
      {
        daemonApiKeys: departed,
        computerBelongsToWorkspace: async () => true,
        revocationReason: async () => undefined,
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      disconnect: { code: 4502, reason: "computer_unlinked" },
    });
  });

  test("refuses a formerly valid key whose Workspace was deleted for good, by its recorded revocation", async () => {
    const asked: string[] = [];
    const response = await authenticateCentrifugoConnect(
      connectRequest({ daemonApiKey: REVOKED_KEY }),
      {
        daemonApiKeys: repository(),
        computerBelongsToWorkspace: async () => true,
        revocationReason: async (apiKeyHash) => {
          asked.push(apiKeyHash);
          return "workspace_deleted";
        },
      },
    );
    expect(asked).toEqual([hashDaemonApiKey(REVOKED_KEY)]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      disconnect: { code: 4501, reason: "workspace_deleted" },
    });
  });

  test("refuses a key whose row is revoked for good, even with no recorded revocation", async () => {
    const keys = repository();
    await keys.replaceActive({
      apiKeyHash: hashDaemonApiKey(REVOKED_KEY),
      workspaceId: "workspace-1",
      computerId: "computer-1",
      ownerId: "user-1",
      revokedAt: new Date(),
      kind: "daemon",
    });
    const response = await authenticateCentrifugoConnect(
      connectRequest({ daemonApiKey: REVOKED_KEY }),
      {
        daemonApiKeys: keys,
        computerBelongsToWorkspace: async () => true,
        revocationReason: async () => undefined,
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      disconnect: { code: 4503, reason: "credential_revoked" },
    });
  });

  test("a recorded revocation reason still wins over the key row's own revokedAt", async () => {
    const keys = repository();
    await keys.replaceActive({
      apiKeyHash: hashDaemonApiKey(REVOKED_KEY),
      workspaceId: "workspace-1",
      computerId: "computer-1",
      ownerId: "user-1",
      revokedAt: new Date(),
      kind: "daemon",
    });
    const response = await authenticateCentrifugoConnect(
      connectRequest({ daemonApiKey: REVOKED_KEY }),
      {
        daemonApiKeys: keys,
        computerBelongsToWorkspace: async () => true,
        revocationReason: async () => "workspace_deleted",
      },
    );
    expect(await response.json()).toEqual({
      disconnect: { code: 4501, reason: "workspace_deleted" },
    });
  });

  test("keeps a key with no recorded revocation a retryable authentication failure", async () => {
    const response = await authenticateCentrifugoConnect(
      connectRequest({ daemonApiKey: REVOKED_KEY }),
      {
        daemonApiKeys: repository(),
        computerBelongsToWorkspace: async () => true,
        revocationReason: async () => undefined,
      },
    );
    expect(response.status).toBe(401);
  });

  test("never looks up a revocation for a value that is not a daemon key", async () => {
    let looked = false;
    const response = await authenticateCentrifugoConnect(
      connectRequest({ daemonApiKey: "not-a-key" }),
      {
        daemonApiKeys: repository(),
        computerBelongsToWorkspace: async () => true,
        revocationReason: async () => {
          looked = true;
          return "workspace_deleted";
        },
      },
    );
    expect(looked).toBe(false);
    expect(response.status).toBe(401);
  });

  test("records a refusal for the Computers page when a bound key is refused for its Computer", async () => {
    const keys = repository();
    keys.token = await createDaemonApiKeyFactory(keys).create({
      principal: { userId: "user-1" },
      workspaceId: "workspace-1",
      computerId: "computer-1",
    });
    const marker = refusals();
    await authenticateCentrifugoConnect(connectRequest({ daemonApiKey: keys.token }), {
      daemonApiKeys: keys,
      computerBelongsToWorkspace: async () => false,
      revocationReason: async () => undefined,
      connectRefusals: marker.connectRefusals,
    });
    expect(marker.recorded).toEqual([
      {
        scope: { workspaceId: "workspace-1", computerId: "computer-1" },
        reason: "computer_unlinked",
      },
    ]);
  });

  test("records a revoked key's refusal under the key row's own scope", async () => {
    const keys = repository();
    await keys.replaceActive({
      apiKeyHash: hashDaemonApiKey(REVOKED_KEY),
      workspaceId: "workspace-1",
      computerId: "computer-1",
      ownerId: "user-1",
      revokedAt: new Date(),
      kind: "daemon",
    });
    const marker = refusals();
    await authenticateCentrifugoConnect(connectRequest({ daemonApiKey: REVOKED_KEY }), {
      daemonApiKeys: keys,
      computerBelongsToWorkspace: async () => true,
      revocationReason: async () => undefined,
      connectRefusals: marker.connectRefusals,
    });
    expect(marker.recorded).toEqual([
      {
        scope: { workspaceId: "workspace-1", computerId: "computer-1" },
        reason: "credential_revoked",
      },
    ]);
  });

  test("records nothing for a refusal that names no Computer scope", async () => {
    const marker = refusals();
    await authenticateCentrifugoConnect(connectRequest({ daemonApiKey: REVOKED_KEY }), {
      daemonApiKeys: repository(),
      computerBelongsToWorkspace: async () => true,
      revocationReason: async () => "workspace_deleted",
      connectRefusals: marker.connectRefusals,
    });
    expect(marker.recorded).toEqual([]);
  });

  test("clears a recorded refusal when the binding connects again", async () => {
    const keys = repository();
    keys.token = await createDaemonApiKeyFactory(keys).create({
      principal: { userId: "user-1" },
      workspaceId: "workspace-1",
      computerId: "computer-1",
    });
    const marker = refusals();
    const response = await authenticateCentrifugoConnect(
      connectRequest({ daemonApiKey: keys.token }),
      {
        daemonApiKeys: keys,
        computerBelongsToWorkspace: async () => true,
        revocationReason: async () => undefined,
        connectRefusals: marker.connectRefusals,
      },
    );
    expect(response.status).toBe(200);
    expect(marker.cleared).toEqual([{ workspaceId: "workspace-1", computerId: "computer-1" }]);
  });

  describe("logs every refusal for good with its reason", () => {
    const warnings: unknown[] = [];
    let warn: ReturnType<typeof spyOn>;
    beforeAll(() => {
      warn = spyOn(console, "warn").mockImplementation((line: unknown) => {
        warnings.push(JSON.parse(String(line)));
      });
    });
    afterEach(() => {
      warnings.length = 0;
    });
    afterAll(() => {
      warn.mockRestore();
    });

    test("an unlinked Computer names the principal", async () => {
      const keys = repository();
      keys.token = await createDaemonApiKeyFactory(keys).create({
        principal: { userId: "user-1" },
        workspaceId: "workspace-1",
        computerId: "computer-1",
      });
      await authenticateCentrifugoConnect(connectRequest({ daemonApiKey: keys.token }), {
        daemonApiKeys: keys,
        computerBelongsToWorkspace: async () => false,
        revocationReason: async () => undefined,
      });
      expect(warnings).toEqual([
        {
          event: "daemon_connect:refused",
          reason: "computer_unlinked",
          workspace_id: "workspace-1",
          computer_id: "computer-1",
        },
      ]);
    });

    test("a revoked key names only the reason", async () => {
      await authenticateCentrifugoConnect(connectRequest({ daemonApiKey: REVOKED_KEY }), {
        daemonApiKeys: repository(),
        computerBelongsToWorkspace: async () => true,
        revocationReason: async () => "workspace_deleted",
      });
      expect(warnings).toEqual([{ event: "daemon_connect:refused", reason: "workspace_deleted" }]);
    });
  });
});
