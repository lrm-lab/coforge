import { describe, expect, test } from "bun:test";

import { hashAgentApiKey } from "#src/server/agents/agent-api-key.server";
import { createAppBotEndpoint } from "#src/server/app-bots/app-bots-composition.server";
import {
  db,
  fixture,
  granted,
  statusRequest,
  tokenRequest,
  useBotHarness,
} from "./app-bots-harness";

/**
 * The calls an app's backend makes about its bot (`bot-token`, `bot-status`) against local
 * PostgreSQL: the key, its rotation, the status line, every refusal and the rate limits.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
useBotHarness();

describe.skipIf(!db)("bot-token (step 3)", () => {
  test("mints the key once: id, key, agent and the four scopes; only a hash is stored", async () => {
    const f = await granted();
    const response = await tokenRequest(f.installationId, f.basic, { rotate: false });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    const row = (await f.botRow())!;
    expect(body).toEqual({
      credentialId: row.credentials[0]!.id,
      apiKey: expect.stringMatching(/^sk_agent_[A-Za-z0-9_-]{43}$/),
      agentId: row.agentId,
      scopes: ["send", "read", "mentions", "channels"],
    });
    expect(row.credentials).toHaveLength(1);
    expect(row.credentials[0]!.keyHash).toBe(hashAgentApiKey(body.apiKey));
    expect(JSON.stringify(row)).not.toContain(body.apiKey);
    expect(await f.bots.authenticate(body.apiKey)).toMatchObject({
      agentId: row.agentId,
      workspaceId: f.workspaceId,
    });
  });

  test("a second call without rotate is credential_exists; rotate replaces the key atomically", async () => {
    const f = await granted();
    const first = await (await tokenRequest(f.installationId, f.basic)).json();
    const refused = await tokenRequest(f.installationId, f.basic, { rotate: false });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toBe("credential_exists");
    expect(await f.bots.authenticate(first.apiKey)).toBeDefined();

    const rotated = await (await tokenRequest(f.installationId, f.basic, { rotate: true })).json();
    expect(rotated.apiKey).not.toBe(first.apiKey);
    expect(await f.bots.authenticate(first.apiKey)).toBeUndefined();
    expect(await f.bots.authenticate(rotated.apiKey)).toBeDefined();
    const live = (await f.botRow())!.credentials.filter((credential) => !credential.revokedAt);
    expect(live).toHaveLength(1);
  });

  test("client credentials only: a user or agent bearer token, wrong secret or none is invalid_client", async () => {
    const f = await granted();
    for (const authorization of [
      null,
      "Bearer abc.def.ghi",
      "Bearer sk_agent_x",
      `Basic ${Buffer.from(`${f.key}:wrong`).toString("base64")}`,
    ]) {
      const response = await tokenRequest(f.installationId, authorization, {});
      expect(response.status).toBe(401);
      expect((await response.json()).error).toBe("invalid_client");
    }
    expect((await f.botRow())!.credentials).toHaveLength(0);
  });

  test("an installation of another app, an unknown one and a malformed id are all installation_not_found", async () => {
    const f = await granted();
    const other = await granted();
    for (const id of [other.installationId, crypto.randomUUID(), "not-a-uuid"]) {
      const response = await tokenRequest(id, f.basic, {});
      expect(response.status).toBe(404);
      expect((await response.json()).error).toBe("installation_not_found");
    }
  });

  test("bot_not_granted when never granted, revoked, or the app stopped declaring a bot", async () => {
    const f = await fixture();
    const never = await tokenRequest(f.installationId, f.basic, {});
    expect(never.status).toBe(403);
    expect((await never.json()).error).toBe("bot_not_granted");
    await f.bots.grant(f.actor("admin"), f.key);
    await f.bots.revoke(f.actor("admin"), f.key);
    expect((await (await tokenRequest(f.installationId, f.basic, {})).json()).error).toBe(
      "bot_not_granted",
    );
    await f.bots.grant(f.actor("admin"), f.key);
    await f.bots.declare(f.actor("owner"), f.key, false);
    expect((await (await tokenRequest(f.installationId, f.basic, {})).json()).error).toBe(
      "bot_not_granted",
    );
  });

  test("bot_not_active (404) when the grant stands but the bot Agent was deleted", async () => {
    const f = await granted();
    await db!.agent.update({
      where: { id: (await f.botRow())!.agentId },
      data: { deletedAt: new Date() },
    });
    const response = await tokenRequest(f.installationId, f.basic, {});
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("bot_not_active");
  });

  test("a bad body is invalid_request", async () => {
    const f = await granted();
    const response = await tokenRequest(f.installationId, f.basic, { rotate: "yes" });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_request");
  });
});

describe.skipIf(!db)("bot-status", () => {
  test("sets a trimmed line, replaces it, and null or an omitted text clears it", async () => {
    const f = await granted();
    const set = await statusRequest(f.installationId, f.basic, {
      text: "  Indexing 2,341 packages ",
    });
    expect(set.status).toBe(200);
    expect((await f.botRow())!.statusText).toBe("Indexing 2,341 packages");
    expect((await f.bots.workspaceBots(f.actor("member"))).get(f.key)?.statusText).toBe(
      "Indexing 2,341 packages",
    );
    await statusRequest(f.installationId, f.basic, { text: "Idle" });
    expect((await f.botRow())!.statusText).toBe("Idle");
    await statusRequest(f.installationId, f.basic, { text: null });
    expect((await f.botRow())!.statusText).toBeNull();
    await statusRequest(f.installationId, f.basic, { text: "again" });
    await statusRequest(f.installationId, f.basic, {});
    expect((await f.botRow())!.statusText).toBeNull();
  });

  test("empty or blank is 400, and 160 UTF-16 units are the limit counted before trimming", async () => {
    const f = await granted();
    for (const text of ["", "   "]) {
      const response = await statusRequest(f.installationId, f.basic, { text });
      expect(response.status).toBe(400);
    }
    expect((await statusRequest(f.installationId, f.basic, { text: "x".repeat(160) })).status).toBe(
      200,
    );
    expect((await statusRequest(f.installationId, f.basic, { text: "x".repeat(161) })).status).toBe(
      400,
    );
    expect(
      (await statusRequest(f.installationId, f.basic, { text: ` ${"x".repeat(160)}` })).status,
    ).toBe(400);
    expect((await statusRequest(f.installationId, f.basic, { text: "😀".repeat(80) })).status).toBe(
      200,
    );
    expect((await statusRequest(f.installationId, f.basic, { text: "😀".repeat(81) })).status).toBe(
      400,
    );
    expect((await statusRequest(f.installationId, f.basic, { text: 5 })).status).toBe(400);
  });

  test("client credentials only", async () => {
    const f = await granted();
    const response = await statusRequest(f.installationId, "Bearer sk_agent_x", { text: "hi" });
    expect(response.status).toBe(401);
  });

  test("refused while not granted, unknown, or the Agent is gone; a revoke clears it so a re-grant does not resurrect it", async () => {
    const f = await granted();
    await statusRequest(f.installationId, f.basic, { text: "Working" });
    await f.bots.revoke(f.actor("admin"), f.key);
    const revoked = await statusRequest(f.installationId, f.basic, { text: "Working" });
    expect(revoked.status).toBe(403);
    expect((await revoked.json()).error).toBe("bot_not_granted");
    expect((await f.botRow())!.statusText).toBeNull();
    await f.bots.grant(f.actor("admin"), f.key);
    expect((await f.botRow())!.statusText).toBeNull();

    const missing = await statusRequest(crypto.randomUUID(), f.basic, { text: "x" });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe("installation_not_found");

    await db!.agent.update({
      where: { id: (await f.botRow())!.agentId },
      data: { deletedAt: new Date() },
    });
    const gone = await statusRequest(f.installationId, f.basic, { text: "x" });
    expect(gone.status).toBe(403);
    expect((await gone.json()).error).toBe("bot_not_active");
  });
});

describe.skipIf(!db)("rate limits", () => {
  /** Admits `allowed` requests per id, then refuses with a seven-second wait; records the ids. */
  function limit(allowed: number) {
    const counts = new Map<string, number>();
    return {
      counts,
      async admit(id: string) {
        const count = (counts.get(id) ?? 0) + 1;
        counts.set(id, count);
        return count <= allowed
          ? ({ allowed: true } as const)
          : ({ allowed: false, retryAfterSeconds: 7 } as const);
      },
    };
  }

  test("bot-token is counted per app and bot-status per app and installation, after the app authenticates", async () => {
    const f = await granted();
    const token = limit(1);
    const installation = limit(1);
    const limited = createAppBotEndpoint(db!, {
      issuer: "https://coforge.test",
      limits: { token, installation },
    });
    const call = (kind: "token" | "status", authorization: string) =>
      kind === "token"
        ? limited.token(
            new Request("https://coforge.test/t", { method: "POST", headers: { authorization } }),
            f.installationId,
          )
        : limited.status(
            new Request("https://coforge.test/s", {
              method: "PUT",
              headers: { authorization },
              body: JSON.stringify({ text: "hi" }),
            }),
            f.installationId,
          );

    // A request that does not authenticate spends nothing.
    expect((await call("token", "Bearer x")).status).toBe(401);
    expect((await call("status", "Bearer x")).status).toBe(401);
    expect(token.counts.size + installation.counts.size).toBe(0);

    expect((await call("token", f.basic)).status).toBe(200);
    const refused = await call("token", f.basic);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("7");
    expect([...token.counts.keys()]).toEqual([f.key]);

    expect((await call("status", f.basic)).status).toBe(200);
    expect((await call("status", f.basic)).status).toBe(429);
    expect([...installation.counts.keys()]).toEqual([`${f.key}:${f.installationId}`]);
  });
});
