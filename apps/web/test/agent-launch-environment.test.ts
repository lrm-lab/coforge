import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mockModuleForFile } from "./helpers/file-module-mock";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { AgentEnvironment } from "#src/server/agents/agent-environment.server";
import { AgentLaunchRefusalError } from "#src/server/agents/agent-control-receiver.server";
import type { AgentRuntimeConfig } from "#src/server/agents/agent-runtime-config.server";

let runtimeConfig: AgentRuntimeConfig = {
  runtime: RUNTIME_PROVIDER.PI,
  provider: { kind: "default" },
  model: "",
  modelProvider: "",
  reasoning: "",
};
let runtimeConfigRevision = 0;
let onAuthorizeLaunch: (() => void) | undefined;
let allowed = true;
let mintFailure = false;
/** How `authorizeLaunch` refuses: not at all, an uncoded error, or the coded refusal a refused
 * relaunch has to be able to name (task #14). */
let launchRefusal: "none" | "plain" | "coded" = "none";
let runtimeAllowed = true;
let lookups = 0;
let issued = 0;
let installedApps: unknown[] = [];
const appQueries: unknown[] = [];
// The route reads its key from the process environment, which a test run inherits from the shell
// that started it. Both settings are this file's to decide: a shell that sourced
// `scripts/e2e/e2e-env.sh` exports `..._KEY_FILE`, and with both set the route refuses to read
// either and answers 503, failing both tests (task #386).
const KEY_ENV = "COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY";
const KEY_SETTINGS = [KEY_ENV, `${KEY_ENV}_FILE`] as const;
let previous: Record<string, string | undefined> = {};
beforeEach(() => {
  previous = Object.fromEntries(KEY_SETTINGS.map((name) => [name, Bun.env[name]]));
  for (const name of KEY_SETTINGS) delete Bun.env[name];
  Bun.env[KEY_ENV] = "07".repeat(32);
});
afterEach(() => {
  for (const name of KEY_SETTINGS) {
    const value = previous[name];
    if (value === undefined) delete Bun.env[name];
    else Bun.env[name] = value;
  }
});
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
        select: { runtimeConfig: true, runtimeConfigRevision: true },
      });
      return allowed
        ? {
            id: "agent-1",
            workspaceId: "workspace-1",
            ownerId: "owner-1",
            runtimeConfig,
            runtimeConfigRevision,
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
  workspace: { findUnique: async () => ({ slug: "acme", experiments: null }) },
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
      onAuthorizeLaunch?.();
      if (launchRefusal === "plain") throw new Error("stale launch");
      if (launchRefusal === "coded")
        throw new AgentLaunchRefusalError("AGENT_LAUNCH_SUPERSEDED", "Stale Agent launch", {
          phase: "completed",
          action: "start",
          sameScope: false,
          stoppedAt: false,
        });
    }
  },
}));
await mockModuleForFile("#src/server/computers/computer-runtime-visibility.server", () => ({
  ComputerRuntimeVisibility: class {
    async checkSelection() {
      return runtimeAllowed
        ? { ok: true as const }
        : {
            ok: false as const,
            code: "RUNTIME_UNAVAILABLE" as const,
            error: "the configured runtime is not available on this Computer",
          };
    }
    async canSelect() {
      return runtimeAllowed;
    }
  },
}));
await mockModuleForFile("#src/server/db/repositories/agent-api-key.repositories.server", () => ({
  PrismaAgentApiKeyRepository: class {
    async rotate() {
      if (mintFailure) throw new Error("mint-exception-marker");
      issued++;
    }
  },
}));
const { Route } = await import("#src/routes/api/agent-api-keys");
const handlers = Route.options.server!.handlers;
if (!handlers || typeof handlers === "function" || typeof handlers.POST !== "function")
  throw new Error("missing POST handler");
const post = handlers.POST;
function request(token?: string, requestId?: string, launchId?: string, body?: string) {
  return post({
    request: new Request("https://example.test/api/agent-api-keys", {
      method: "POST",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(requestId ? { "x-request-id": requestId } : {}),
      },
      body: body ?? JSON.stringify({ agentId: "agent-1", workspaceId: "workspace-1", launchId }),
    }),
  } as Extract<Parameters<typeof post>[0], { pathname: string }>);
}
afterAll(() => {
  mock.restore();
});

test("launch HTTP outcomes correlate verified scope without copying request or error text", async () => {
  const savedConfig = runtimeConfig;
  const savedIssued = issued;
  runtimeConfig = { ...runtimeConfig, environment: undefined };
  const records: Record<string, unknown>[] = [];
  const capture = (line: string) => void records.push(JSON.parse(line));
  const info = spyOn(console, "info").mockImplementation(capture);
  const warn = spyOn(console, "warn").mockImplementation(capture);
  const error = spyOn(console, "error").mockImplementation(capture);
  const requestId = crypto.randomUUID();
  const concurrentId = crypto.randomUUID();
  const launchId = crypto.randomUUID();
  const launchDigest = Bun.CryptoHasher.hash("sha256", launchId, "hex");
  try {
    const successes = await Promise.all(
      [requestId, concurrentId].map((id) => request("valid", id, launchId)),
    );
    expect(successes.map((response) => (response as Response).status)).toEqual([200, 200]);
    expect(((await request("invalid", "unsafe-header-marker", launchId)) as Response).status).toBe(
      401,
    );
    expect(((await request("valid", undefined, undefined, "body-marker")) as Response).status).toBe(
      400,
    );
    allowed = false;
    expect(((await request("valid", undefined, launchId)) as Response).status).toBe(403);
    allowed = true;
    launchRefusal = "coded";
    expect(((await request("valid", undefined, launchId)) as Response).status).toBe(403);
    launchRefusal = "plain";
    expect(((await request("valid", undefined, "legacy-launch-marker")) as Response).status).toBe(
      403,
    );
    launchRefusal = "none";
    mintFailure = true;
    await expect(request("valid")).rejects.toThrow("mint-exception-marker");
    const outcomes = records.filter(
      ({ event }) => event === "agent_launch_config.request_finished",
    );
    expect(outcomes.slice(0, 2)).toEqual(
      expect.arrayContaining(
        [requestId, concurrentId].map((id) =>
          expect.objectContaining({
            request_id: id,
            agent_id: "agent-1",
            computer_id: "computer-1",
            launch_digest: launchDigest,
            http_status: 200,
            outcome: "ok",
          }),
        ),
      ),
    );
    expect(outcomes.slice(2)).toEqual([
      expect.objectContaining({
        http_status: 401,
        outcome: "rejected",
        reason_code: "DAEMON_UNAUTHORIZED",
      }),
      expect.objectContaining({ http_status: 400, reason_code: "INVALID_REQUEST" }),
      expect.objectContaining({
        http_status: 403,
        reason_code: "AGENT_LAUNCH_NOT_AUTHORIZED",
      }),
      expect.objectContaining({
        http_status: 403,
        launch_digest: launchDigest,
        reason_code: "AGENT_LAUNCH_SUPERSEDED",
      }),
      expect.objectContaining({
        http_status: 403,
        outcome: "rejected",
        reason_code: "LAUNCH_AUTHORIZATION_FAILED",
      }),
      expect.objectContaining({ outcome: "failed", reason_code: "LAUNCH_CONFIG_UNEXPECTED" }),
    ]);
    expect(outcomes[2]!.request_id).toMatch(/^[\da-f-]{36}$/i);
    expect(outcomes[2]).not.toHaveProperty("agent_id");
    expect(outcomes[2]).not.toHaveProperty("computer_id");
    expect(outcomes[2]).not.toHaveProperty("launch_digest");
    expect(outcomes[4]).not.toHaveProperty("agent_id");
    expect(outcomes[4]).not.toHaveProperty("launch_digest");
    expect(outcomes[6]).not.toHaveProperty("launch_digest");
    expect(outcomes[7]).not.toHaveProperty("http_status");
    const serialized = JSON.stringify(records);
    for (const excluded of [
      launchId,
      "legacy-launch-marker",
      "unsafe-header-marker",
      "body-marker",
      "stale launch",
      "Stale Agent launch",
      "mint-exception-marker",
      "sk_agent_",
    ])
      expect(serialized).not.toContain(excluded);
  } finally {
    info.mockRestore();
    warn.mockRestore();
    error.mockRestore();
    runtimeConfig = savedConfig;
    issued = savedIssued;
    launchRefusal = "none";
    allowed = true;
    mintFailure = false;
  }
});

test("authorized launch HTTP response contains decrypted explicit env only, no-store; unauthorized and stale launches never decrypt", async () => {
  const principal = { workspaceId: "workspace-1", userId: "owner-1" };
  const environment = new AgentEnvironment(
    {
      findOwnedAgent: async () => ({ runtimeConfig }),
      updateRuntimeConfig: async (_id, config) => {
        runtimeConfig = config;
        runtimeConfigRevision++;
        return { runtimeConfig: config };
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
  const previousConfig = runtimeConfig;
  const previousRevision = runtimeConfigRevision;
  await environment.save(principal, "agent-1", { OPENROUTER_API_KEY: "updated-fixture" });
  const savedConfig = runtimeConfig;
  const savedRevision = runtimeConfigRevision;
  runtimeConfig = previousConfig;
  runtimeConfigRevision = previousRevision;
  onAuthorizeLaunch = () => {
    runtimeConfig = savedConfig;
    runtimeConfigRevision = savedRevision;
    onAuthorizeLaunch = undefined;
  };

  const response = (await request("valid")) as Response;
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const payload = await response.json();
  expect(payload.envVars).toEqual({ OPENROUTER_API_KEY: "explicit-secret", EMPTY: "" });
  expect(payload.runtimeConfigRevision).toBe(previousRevision);
  expect(runtimeConfigRevision).toBe(savedRevision);
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
    features: {
      taskConversations: true,
      artifacts: true,
      artifactChecks: false,
      agentContextView: false,
    },
  });
  expect(JSON.stringify(payload)).not.toContain(previousConfig.environment!.ciphertext);
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
  launchRefusal = "plain";
  const uncoded = (await request("valid")) as Response;
  expect(uncoded.status).toBe(403);
  expect(await uncoded.json()).toEqual({ error: "forbidden" });
  // A coded refusal names the fence in the body's `code` and in the server's own warning: the
  // Daemon writes the code down, so a refused relaunch stops reading as one opaque 403 (task #14).
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
  try {
    launchRefusal = "coded";
    const coded = (await request("valid")) as Response;
    expect(coded.status).toBe(403);
    expect(await coded.json()).toEqual({
      error: "Stale Agent launch",
      code: "AGENT_LAUNCH_SUPERSEDED",
      retryable: false,
    });
    // The warning carries what the fence read, and nothing from the Agent's credentials.
    expect(warnings).toContainEqual(
      JSON.stringify({
        event: "agent_launch.refused",
        agent_id: "agent-1",
        computer_id: "computer-1",
        code: "AGENT_LAUNCH_SUPERSEDED",
        phase: "completed",
        action: "start",
        same_scope: false,
        stopped_at: false,
      }),
    );
  } finally {
    console.warn = originalWarn;
    launchRefusal = "none";
  }
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
    installations: [{}],
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
