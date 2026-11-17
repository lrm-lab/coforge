import { describe, expect, test } from "bun:test";
import {
  ExternalPushWebhooks,
  PushWebhookRefusal,
} from "#src/server/agents/external-push-webhooks.server";
import { handlePushWebhook } from "#src/server/agents/external-push-webhook-http.server";
import { NonPublicAddressError } from "#src/server/egress/outbound-egress.server";
import { pushWebhookSealer } from "#src/server/agents/external-push-webhook-secret.server";
import { MemoryPushWebhookStore } from "./helpers/memory-push-webhook-store";

const SECRET = "a".repeat(64);
const principal = { agentId: "a1", workspaceId: "w1" };

function setup(over: { queue?: boolean; sealer?: boolean; egressFails?: boolean } = {}) {
  const store = new MemoryPushWebhookStore();
  store.addAgent("a1");
  const sealer = pushWebhookSealer(new Uint8Array(32).fill(7));
  const service = new ExternalPushWebhooks(store, {
    egress: {
      resolveTarget: async () => {
        if (over.egressFails) throw new NonPublicAddressError();
        return { hostname: "h", address: "1.2.3.4", family: 4 as const };
      },
    },
    sealer: async () => (over.sealer === false ? undefined : sealer),
    ensureQueue: async () => over.queue !== false,
    now: () => new Date("2026-11-17T00:00:00Z"),
  });
  return { store, service, sealer };
}

async function refusal(promise: Promise<unknown>): Promise<PushWebhookRefusal> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PushWebhookRefusal);
  return error as PushWebhookRefusal;
}

describe("registering a push webhook", () => {
  test("stores the secret sealed, never the plain secret, and never returns it", async () => {
    const { store, service, sealer } = setup();
    const view = await service.put(principal, {
      url: "https://hooks.example/inbox",
      secret: SECRET,
    });
    expect(JSON.stringify(view)).not.toContain(SECRET);
    expect(view).toEqual({
      url: "https://hooks.example/inbox",
      enabled: true,
      disabledReason: null,
      lastDeliveryAt: null,
      lastError: null,
      consecutiveFailures: 0,
    });
    const row = store.rows.get("a1")!;
    expect(row.secretSealed).not.toContain(SECRET);
    expect(await sealer.open("a1", row.secretSealed)).toBe(SECRET);
    await expect(sealer.open("another-agent", row.secretSealed)).rejects.toBeDefined();
  });

  test("a second PUT replaces the registration, re-enables it and clears the failure state", async () => {
    const { store, service } = setup();
    await service.put(principal, { url: "https://hooks.example/a", secret: SECRET });
    const row = store.rows.get("a1")!;
    store.rows.set("a1", {
      ...row,
      enabled: false,
      disabledReason: "endpoint_rejected",
      consecutiveFailures: 4,
    });
    const view = await service.put(principal, {
      url: "https://hooks.example/b",
      secret: "Z".repeat(43),
    });
    expect(view).toMatchObject({
      url: "https://hooks.example/b",
      enabled: true,
      disabledReason: null,
      consecutiveFailures: 0,
    });
    expect(store.rows.get("a1")!.revision).toBe(2);
  });

  test.each([
    ["http://hooks.example/x", SECRET, "invalid_url"],
    ["https://user:pw@hooks.example/x", SECRET, "invalid_url"],
    ["https://hooks.example/x", "short", "weak_secret"],
    ["https://hooks.example/x", "a".repeat(63), "weak_secret"],
    ["https://hooks.example/x", "has space".repeat(10), "weak_secret"],
  ])("%s with %s is refused as %s", async (url, secret, code) => {
    const { service } = setup();
    const refused = await refusal(service.put(principal, { url, secret }));
    expect([refused.code, refused.status]).toEqual([code, 400]);
  });

  test("an endpoint that resolves to a non-public address is refused", async () => {
    const { service } = setup({ egressFails: true });
    const refused = await refusal(
      service.put(principal, { url: "https://hooks.example/x", secret: SECRET }),
    );
    expect(refused.code).toBe("endpoint_not_public");
  });

  test("a deployment without a sealing key or a running queue answers 503", async () => {
    for (const over of [{ sealer: false }, { queue: false }]) {
      const { service } = setup(over);
      const refused = await refusal(
        service.put(principal, { url: "https://hooks.example/x", secret: SECRET }),
      );
      expect([refused.code, refused.status]).toEqual(["push_webhook_unavailable", 503]);
    }
  });

  test("a body that is not an object is refused", async () => {
    const { service } = setup();
    expect((await refusal(service.put(principal, "nope"))).code).toBe("invalid_url");
  });
});

describe("reading and removing it", () => {
  test("reads the status and answers null once there is none", async () => {
    const { service } = setup();
    expect(await service.get("a1")).toBeNull();
    await service.put(principal, { url: "https://hooks.example/x", secret: SECRET });
    expect((await service.get("a1"))!.url).toBe("https://hooks.example/x");
    expect(await service.remove("a1")).toBe(true);
    expect(await service.get("a1")).toBeNull();
    expect(await service.remove("a1")).toBe(false);
  });
});

describe("the HTTP adapter", () => {
  const external = { workspaceId: "w1", agentId: "a1", external: true, credentialId: "c" } as never;
  const request = (method: string, body?: unknown) =>
    new Request("https://x.test/api/agent/v1/push-webhook", {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  test("a managed Agent gets 403", async () => {
    const { service } = setup();
    const response = await handlePushWebhook(
      request("GET"),
      { workspaceId: "w1", agentId: "a1" },
      service,
    );
    expect(response.status).toBe(403);
  });

  test("GET is 404 until registered, PUT answers the view without the secret, DELETE removes", async () => {
    const { service } = setup();
    expect((await handlePushWebhook(request("GET"), external, service)).status).toBe(404);
    const put = await handlePushWebhook(
      request("PUT", { url: "https://hooks.example/x", secret: SECRET }),
      external,
      service,
    );
    expect(put.status).toBe(200);
    expect(await put.text()).not.toContain(SECRET);
    expect((await handlePushWebhook(request("GET"), external, service)).status).toBe(200);
    expect((await handlePushWebhook(request("DELETE"), external, service)).status).toBe(200);
    expect((await handlePushWebhook(request("GET"), external, service)).status).toBe(404);
  });

  test("a refusal keeps its status and code", async () => {
    const { service } = setup();
    const response = await handlePushWebhook(
      request("PUT", { url: "http://x", secret: SECRET }),
      external,
      service,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_url" });
  });
});
