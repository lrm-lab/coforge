import { afterAll, expect, mock, test } from "bun:test";
import { mockModuleForFile } from "./helpers/file-module-mock";

let linked = true;
const db = {
  workspaceComputer: {
    findUnique: async (query: unknown) => {
      expect(query).toMatchObject({
        where: { workspaceId_computerId: { workspaceId: "workspace-1", computerId: "computer-1" } },
      });
      return linked ? { id: "link-1" } : null;
    },
  },
};
await mockModuleForFile("#src/server/db/client.server", () => ({ getDatabaseClient: () => db }));
await mockModuleForFile("#src/server/auth/daemon-api-key.server", () => ({
  verifyDaemonApiKey: async (key: string) => {
    if (key !== "valid") throw new Error("invalid");
    return { computerId: "computer-1", workspaceId: "workspace-1", userId: "owner-1" };
  },
}));
// No migration exists in this fake, so every operation past authentication finds nothing.
await mockModuleForFile("#src/server/agent-migrations/agent-migration-composition.server", () => ({
  agentMigrationServices: async () => ({
    transport: { view: async () => null },
    orchestrator: {},
  }),
}));
const { Route } = await import("#src/routes/api/daemon/agent-migrations");
const handlers = Route.options.server!.handlers;
if (!handlers || typeof handlers === "function" || typeof handlers.POST !== "function")
  throw new Error("missing POST handler");
const post = handlers.POST;
afterAll(() => mock.restore());

async function request(body: Record<string, unknown> | string, token: string | null = "valid") {
  return (await post({
    request: new Request("https://example.test/api/daemon/agent-migrations", {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: typeof body === "string" ? body : JSON.stringify({ version: 1, ...body }),
    }),
  } as Parameters<typeof post>[0])) as Response;
}

const view = { operation: "view", migrationId: "00000000-0000-7000-8000-000000000001" };

test("the daemon route answers only a linked Computer's valid daemon key, never cached", async () => {
  expect((await request(view, null)).status).toBe(401);
  expect((await request(view, "revoked")).status).toBe(401);
  expect((await request("{", "valid")).status).toBe(400);
  expect((await request({ operation: "cancel", migrationId: "m" })).status).toBe(400);
  expect((await request({ operation: "view", migrationId: "not-a-uuid" })).status).toBe(400);
  expect((await request({ ...view, version: 2 })).status).toBe(400);
  linked = false;
  expect((await request(view)).status).toBe(403);
  linked = true;
  const answered = await request(view);
  expect(answered.status).toBe(404);
  expect(answered.headers.get("cache-control")).toBe("no-store");
  expect(await answered.json()).toEqual({ error: "not_found" });
});
