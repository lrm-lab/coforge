import { describe, expect, test } from "bun:test";
import { agentApiRoutes, createAgentApiClient, type AgentApiTransport } from "../src/agent";

describe("createAgentApiClient consolidated routes", () => {
  test("routes threads.follow, artifacts.execute, apps.*, registrations.*, and management.execute with typed decoders", async () => {
    const calls: { route: unknown; input?: unknown }[] = [];
    const transport: AgentApiTransport = {
      async request(route, input) {
        calls.push({ route, input });
        if (
          typeof route === "string" &&
          route === agentApiRoutes.cloud.threads.follow.path("#general:12345678")
        ) {
          return {
            ok: true,
            status: 200,
            data: { idempotencyKey: "k1", target: "#general:12345678", followed: true },
          };
        }
        if (route === agentApiRoutes.local.artifacts) {
          return {
            ok: true,
            status: 200,
            data: { ok: true, artifacts: [], nextCursor: null },
          };
        }
        if (route === agentApiRoutes.local.apps.list) {
          return {
            ok: true,
            status: 200,
            data: { ok: true, apps: [] },
          };
        }
        if (route === agentApiRoutes.local.apps.marketplace) {
          return {
            ok: true,
            status: 200,
            data: {
              surface: "public_marketplace",
              metadataTrust: "untrusted_app_supplied",
              query: "git",
              limit: 5,
              truncated: false,
              apps: [],
            },
          };
        }
        if (
          typeof route === "object" &&
          route !== null &&
          "path" in route &&
          (route as { path: string }).path === agentApiRoutes.local.apps.token.path("linear")
        ) {
          return {
            ok: true,
            status: 200,
            data: {
              ok: true,
              status: "issued",
              access_token: "tok_123",
              token_type: "Bearer",
              expires_in: 300,
              audience: "linear",
              scope: "read",
            },
          };
        }
        if (route === agentApiRoutes.local.appRegistrations) {
          const op = (input as { operation: string }).operation;
          if (op === "owned_list") {
            return { ok: true, status: 200, data: { ok: true, pending: [], apps: [] } };
          }
          if (op === "register_status") {
            return {
              ok: true,
              status: 200,
              data: { ok: true, status: "card_pending", cardMessageId: "msg-1" },
            };
          }
          if (op === "rotate_secret") {
            return {
              ok: true,
              status: 200,
              data: { ok: true, clientKey: "my-app", clientSecret: "cfa_secret_abc" },
            };
          }
          if (op === "delete") {
            return {
              ok: true,
              status: 200,
              data: { ok: true, clientKey: "my-app", deleted: true },
            };
          }
        }
        return { ok: false, status: 404, error: "not mocked" };
      },
    };

    const client = createAgentApiClient(transport);

    const followed = await client.threads.follow("#general:12345678");
    expect(followed).toEqual({
      idempotencyKey: "k1",
      target: "#general:12345678",
      followed: true,
    });

    const artifacts = await client.artifacts.execute({ operation: "list", limit: 20 });
    expect(artifacts).toEqual({ ok: true, artifacts: [], nextCursor: null });

    expect(await client.apps.list()).toEqual({ ok: true, apps: [] });
    expect(await client.apps.marketplace({ query: "git", limit: 5 })).toEqual({
      surface: "public_marketplace",
      metadataTrust: "untrusted_app_supplied",
      query: "git",
      limit: 5,
      truncated: false,
      apps: [],
    });
    const token = await client.apps.token("linear", { target: "#general", scopes: ["read"] });
    expect(token).toMatchObject({ ok: true, status: "issued", access_token: "tok_123" });

    expect(await client.apps.registrations.owned()).toEqual({ ok: true, pending: [], apps: [] });
    expect(await client.apps.registrations.status({ card: "msg-1" })).toEqual({
      ok: true,
      status: "card_pending",
      cardMessageId: "msg-1",
    });
    expect(await client.apps.registrations.rotateSecret("my-app")).toEqual({
      ok: true,
      clientKey: "my-app",
      clientSecret: "cfa_secret_abc",
    });
    expect(await client.apps.management.execute("delete", { clientKey: "my-app" })).toEqual({
      ok: true,
      clientKey: "my-app",
      deleted: true,
    });
    expect(calls.length).toBe(9);
  });
});
