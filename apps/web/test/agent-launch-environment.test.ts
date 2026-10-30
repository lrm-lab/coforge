import { afterAll, expect, mock, test } from "bun:test";
import { mockModuleForFile } from "./helpers/file-module-mock";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { AgentEnvironment } from "#src/server/agents/agent-environment.server";
import type { AgentRuntimeConfig } from "#src/server/agents/agent-runtime-config.server";

let runtimeConfig: AgentRuntimeConfig = {
  runtime: RUNTIME_PROVIDER.PI,
  provider: { kind: "default" },
  model: "",
  modelProvider: "",
  reasoning: "",
};
let allowed = true;
let launchAllowed = true;
let runtimeAllowed = true;
let lookups = 0;
let issued = 0;
let installedApps: unknown[] = [];
const appQueries: unknown[] = [];
const previous = Bun.env.COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY;
Bun.env.COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY = "07".repeat(32);
const db = {
  agent: {
    findFirst: async (query: unknown) => {
      lookups++;
      expect(query).toMatchObject({
        where: {
          id: "agent-1",
          workspaceId: "workspace-1",
          computerId: "computer-1",
          owner: { memberships: { some: { workspaceId: "workspace-1" } } },
        },
      });
      return allowed
        ? {
            id: "agent-1",
            workspaceId: "workspace-1",
            ownerId: "owner-1",
            runtimeConfig,
            name: "scout",
            displayName: "Scout",
            description: "Reviews pull requests.",
            workspace: { slug: "acme", name: "Acme" },
            computer: {
              name: "workstation-7",
              displayName: "Builder Box",
              platform: "darwin",
              osVersion: "15.6",
              computerVersion: "0.1.0-dev.40",
            },
          }
        : null;
    },
  },
  app: {
    findMany: async (query: unknown) => {
      appQueries.push(query);
      return installedApps;
    },
  },
  appAgentGrant: { findMany: async () => [] },
};
await mockModuleForFile("#src/server/db/client.server", () => ({ getDatabaseClient: () => db }));
await mockModuleForFile("#src/server/auth/daemon-api-key.server", () => ({
  verifyDaemonApiKey: async (key: string) => {
    if (key !== "valid") throw new Error("invalid");
    return { computerId: "computer-1", workspaceId: "workspace-1", userId: "owner-1" };
  },
}));
await mockModuleForFile("#src/server/centrifugo/server-api.server", () => ({
  createCentrifugoServerApi: () => ({}),
}));
await mockModuleForFile("#src/server/agents/agent-runtime-lock.server", () => ({
  getAgentRuntimeLock: () => ({}),
}));
await mockModuleForFile("#src/server/agents/agent-control.server", () => ({
  AgentControl: class {
    async authorizeLaunch() {
      if (!launchAllowed) throw new Error("stale launch");
    }
  },
}));
await mockModuleForFile("#src/server/computers/computer-runtime-visibility.server", () => ({
  ComputerRuntimeVisibility: class {
    async canSelect() {
      return runtimeAllowed;
    }
  },
}));
await mockModuleForFile("#src/server/db/repositories/agent-api-key.repositories.server", () => ({
  PrismaAgentApiKeyRepository: class {
    async replaceActive() {
      issued++;
    }
  },
}));
const { Route } = await import("#src/routes/api/agent-api-keys");
const handlers = Route.options.server!.handlers;
if (!handlers || typeof handlers === "function" || typeof handlers.POST !== "function")
  throw new Error("missing POST handler");
const post = handlers.POST;
function request(token?: string) {
  return post({
    request: new Request("https://example.test/api/agent-api-keys", {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: JSON.stringify({ agentId: "agent-1", workspaceId: "workspace-1" }),
    }),
  } as Parameters<typeof post>[0]);
}
afterAll(() => {
  if (previous === undefined) delete Bun.env.COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY;
  else Bun.env.COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY = previous;
  mock.restore();
});

test("authorized launch HTTP response contains decrypted explicit env only, no-store; unauthorized and stale launches never decrypt", async () => {
  const principal = { workspaceId: "workspace-1", userId: "owner-1" };
  const environment = new AgentEnvironment(
    {
      findOwnedAgent: async () => ({ runtimeConfig }),
      updateRuntimeConfig: async (_id, config) => {
        runtimeConfig = config;
      },
    },
    {
      getById: async () => ({
        id: "agent-1",
        ownerId: "owner-1",
        workspaceId: "workspace-1",
        computerId: "computer-1",
        name: "builder",
        displayName: "Builder",
        createdAt: new Date(),
        runtimeConfig,
      }),
    },
    { stop: async () => {}, start: async () => {} },
    { run: async (_id, callback) => callback() },
    new Uint8Array(32).fill(7),
  );
  await environment.save(principal, "agent-1", {
    OPENROUTER_API_KEY: "explicit-secret",
    EMPTY: "",
  });
  const response = (await request("valid")) as Response;
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const payload = await response.json();
  expect(payload.envVars).toEqual({ OPENROUTER_API_KEY: "explicit-secret", EMPTY: "" });
  expect(payload.apiKey).toMatch(/^sk_agent_/);
  expect(payload.identity).toEqual({
    name: "scout",
    displayName: "Scout",
    description: "Reviews pull requests.",
    runtimeContext: {
      workspaceId: "workspace-1",
      workspaceSlug: "acme",
      workspaceName: "Acme",
      computerId: "computer-1",
      computerName: "Builder Box",
      computerOs: "darwin 15.6",
      computerVersion: "0.1.0-dev.40",
      computerHostname: "workstation-7",
    },
  });
  expect(JSON.stringify(payload)).not.toContain(runtimeConfig.environment!.ciphertext);
  const queried = lookups;
  expect(((await request()) as Response).status).toBe(401);
  expect(((await request("invalid")) as Response).status).toBe(401);
  expect(lookups).toBe(queried);
  runtimeConfig.environment!.ciphertext = "broken";
  allowed = false;
  expect(((await request("valid")) as Response).status).toBe(403);
  allowed = true;
  runtimeAllowed = false;
  const unavailable = (await request("valid")) as Response;
  expect(unavailable.status).toBe(403);
  expect(await unavailable.json()).toEqual({
    error: "the configured runtime is not available on this Computer",
    code: "RUNTIME_UNAVAILABLE",
    retryable: false,
  });
  runtimeAllowed = true;
  launchAllowed = false;
  expect(((await request("valid")) as Response).status).toBe(403);
  launchAllowed = true;
  const failed = (await request("valid")) as Response;
  expect(failed.status).toBe(503);
  expect(await failed.json()).toEqual({ error: "service unavailable" });
  expect(issued).toBe(1);
});

test("the launch identity names the apps installed in the Agent's Workspace, and omits apps when there are none", async () => {
  const appRow = (key: string, name: string) => ({
    key,
    ownerWorkspaceId: "workspace-1",
    name,
    description: `${name} for the team.`,
    whenToUse: `Use ${name}.`,
    homepageUrl: null,
    redirectUris: [],
    category: "productivity",
    allowedScopes: ["openid"],
    secretRotatedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    installations: [{ agentAccess: "all", agents: [] }],
  });
  // The test above leaves an environment that no longer decrypts.
  runtimeConfig = { ...runtimeConfig, environment: undefined };
  installedApps = [appRow("acme-notes", "Acme Notes"), appRow("zeta-board", "Zeta Board")];
  appQueries.length = 0;
  try {
    const payload = await ((await request("valid")) as Response).json();
    expect(appQueries).toEqual([
      expect.objectContaining({
        where: { installations: { some: { workspaceId: "workspace-1" } } },
      }),
    ]);
    expect(payload.identity.apps).toEqual([
      {
        key: "acme-notes",
        name: "Acme Notes",
        description: "Acme Notes for the team.",
        whenToUse: "Use Acme Notes.",
      },
      {
        key: "zeta-board",
        name: "Zeta Board",
        description: "Zeta Board for the team.",
        whenToUse: "Use Zeta Board.",
      },
    ]);
  } finally {
    installedApps = [];
  }
  const payload = await ((await request("valid")) as Response).json();
  expect(payload.identity).not.toHaveProperty("apps");
});
