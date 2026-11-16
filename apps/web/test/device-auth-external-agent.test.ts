import { describe, expect, test } from "bun:test";
import {
  approveUserCode,
  authorizeDevice,
  denyUserCode,
  lookupUserCode,
  pollDeviceToken,
  type DeviceAuthorizationRecord,
  type DeviceAuthorizationStore,
} from "#src/server/auth/device-auth.server";
import {
  EXTERNAL_DEVICE_CLIENT_ID,
  parseExternalAuthorizeBody,
  resolveExternalAgentGrant,
  type ExternalAgentDeviceDeps,
  type ExternalAgentDeviceDirectory,
} from "#src/server/auth/device-auth-external-agent.server";
import { isExternalAgentKeyShape } from "#src/server/agents/external-agent-credentials.server";
import { MemoryExternalAgentCredentials } from "./helpers/memory-external-agent-credentials";

type Row = DeviceAuthorizationRecord & { deviceHash: string; userHash: string };

function memoryStore() {
  const rows = new Map<string, Row>();
  const store: DeviceAuthorizationStore = {
    async create({ deviceCodeHash, userCodeHash, expiresAt, clientId, grant }) {
      const row: Row = {
        id: String(rows.size + 1),
        userId: null,
        status: "pending",
        expiresAt,
        lastPolledAt: null,
        clientId: clientId ?? "coforge-computer",
        grant: grant ?? null,
        approvedAgentId: null,
        approvedWorkspaceId: null,
        deviceHash: deviceCodeHash,
        userHash: userCodeHash,
      };
      rows.set(row.id, row);
      return row;
    },
    async findByDeviceCodeHash(hash) {
      const row = [...rows.values()].find((entry) => entry.deviceHash === hash);
      return row ? { ...row } : null;
    },
    async findByUserCodeHash(hash) {
      const row = [...rows.values()].find((entry) => entry.userHash === hash);
      return row ? { ...row } : null;
    },
    async markPolled(id, at) {
      const row = rows.get(id);
      if (row) row.lastPolledAt = at;
    },
    async approve(id, userId, at, approval) {
      const row = rows.get(id);
      if (row?.status !== "pending" || row.expiresAt.getTime() <= at.getTime()) return false;
      row.status = "approved";
      row.userId = userId;
      row.approvedAgentId = approval?.agentId ?? null;
      row.approvedWorkspaceId = approval?.workspaceId ?? null;
      return true;
    },
    async deny(id) {
      const row = rows.get(id);
      if (row?.status !== "pending") return false;
      row.status = "denied";
      return true;
    },
    async consume(id) {
      const row = rows.get(id);
      if (row?.status !== "approved") return false;
      row.status = "consumed";
      return true;
    },
  };
  return { store, rows };
}

const environment = {
  COFORGE_WORKER_JWT_PRIVATE_JWK: JSON.stringify({
    kty: "OKP",
    crv: "Ed25519",
    d: "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A",
    x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
  }),
  COFORGE_WORKER_JWT_KEY_ID: "test-key",
};

const WORKSPACE_ID = "ws-1";
const AGENT_ID = "agent-1";
const OWNER = "owner-1";
const STRANGER = "stranger-1";
const START = Date.parse("2026-11-16T00:00:00Z");

function directory(
  overrides: { hosting?: string; refusal?: (userId: string) => string | undefined } = {},
): ExternalAgentDeviceDirectory {
  return {
    async resolve(workspaceSlug, agentName) {
      return workspaceSlug === "acme" && agentName === "scout"
        ? {
            workspaceId: WORKSPACE_ID,
            agentId: AGENT_ID,
            hosting: overrides.hosting ?? "external",
          }
        : undefined;
    },
    async identity() {
      return {
        agent: { name: "scout", displayName: "Scout" },
        workspace: { name: "Acme", slug: "acme" },
      };
    },
    async approvalRefusal({ userId }) {
      return (overrides.refusal?.(userId) ??
        (userId === OWNER ? undefined : "not_authorized")) as never;
    },
  };
}

function deps(overrides: Parameters<typeof directory>[0] = {}) {
  const credentials = new MemoryExternalAgentCredentials();
  credentials.addAgent(AGENT_ID);
  return {
    credentials,
    external: { directory: directory(overrides), credentials } satisfies ExternalAgentDeviceDeps,
  };
}

const BODY = new URLSearchParams({
  client_id: "coforge-cli",
  workspace: "acme",
  agent: "scout",
  machine_name: "laptop",
  hostname: "mac.local",
  os: "darwin",
  client_name: "coforge 1.0",
});

async function externalGrant(store: DeviceAuthorizationStore, d = directory()) {
  const request = parseExternalAuthorizeBody(BODY)!;
  const resolution = await resolveExternalAgentGrant(d, request);
  if (!resolution.ok) throw new Error("grant refused");
  return authorizeDevice({
    store,
    origin: "https://example.test",
    now: () => START,
    clientId: EXTERNAL_DEVICE_CLIENT_ID,
    grant: resolution.grant,
  });
}

describe("coforge-cli authorize", () => {
  test("every machine field and the Agent are required and bounded", () => {
    expect(parseExternalAuthorizeBody(BODY)).toEqual({
      workspace: "acme",
      agent: "scout",
      machine: {
        machineName: "laptop",
        hostname: "mac.local",
        os: "darwin",
        clientName: "coforge 1.0",
      },
    });
    for (const field of ["workspace", "agent", "machine_name", "hostname", "os", "client_name"]) {
      const missing = new URLSearchParams(BODY);
      missing.delete(field);
      expect(parseExternalAuthorizeBody(missing)).toBeUndefined();
      const blank = new URLSearchParams(BODY);
      blank.set(field, "   ");
      expect(parseExternalAuthorizeBody(blank)).toBeUndefined();
    }
    const long = new URLSearchParams(BODY);
    long.set("machine_name", "x".repeat(101));
    expect(parseExternalAuthorizeBody(long)).toBeUndefined();
    const control = new URLSearchParams(BODY);
    control.set("hostname", "bad\nhost");
    expect(parseExternalAuthorizeBody(control)).toBeUndefined();
  });

  test("an unknown Workspace or Agent and a managed Agent are one refusal before sign-in", async () => {
    const request = parseExternalAuthorizeBody(BODY)!;
    for (const resolution of [
      await resolveExternalAgentGrant(directory(), { ...request, workspace: "nope" }),
      await resolveExternalAgentGrant(directory(), { ...request, agent: "nope" }),
      await resolveExternalAgentGrant(directory({ hosting: "managed" }), request),
    ])
      expect(resolution).toEqual({ ok: false });
  });

  test("the grant is stored with the client id and carries no verification_uri_complete", async () => {
    const { store, rows } = memoryStore();
    const grant = await externalGrant(store);
    expect(grant).not.toHaveProperty("verificationUriComplete");
    const [row] = [...rows.values()];
    expect(row!.clientId).toBe("coforge-cli");
    expect(row!.grant).toEqual({
      kind: "external_agent",
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      machineName: "laptop",
      hostname: "mac.local",
      os: "darwin",
      clientName: "coforge 1.0",
    });
  });
});

describe("the approval page lookup", () => {
  test("a person who may not approve learns only that, never the Agent or the machine", async () => {
    const { store } = memoryStore();
    const grant = await externalGrant(store);
    expect(
      await lookupUserCode({
        store,
        userCode: grant.userCode,
        userId: STRANGER,
        now: () => START,
        directory: directory(),
      }),
    ).toEqual({ found: false, reason: "not_authorized" });
  });

  test("a coforge-cli code returns the grant details to a person who may approve it", async () => {
    const { store } = memoryStore();
    const grant = await externalGrant(store);
    const lookup = await lookupUserCode({
      store,
      userCode: grant.userCode,
      userId: OWNER,
      now: () => START,
      directory: directory(),
    });
    expect(lookup).toMatchObject({
      found: true,
      external: {
        agent: { name: "scout", displayName: "Scout" },
        workspace: { name: "Acme", slug: "acme" },
        machine: {
          machineName: "laptop",
          hostname: "mac.local",
          os: "darwin",
          clientName: "coforge 1.0",
        },
      },
    });
  });

  test("a Computer code has no grant details, and a cli code without a directory is unknown", async () => {
    const { store } = memoryStore();
    const computer = await authorizeDevice({
      store,
      origin: "https://example.test",
      now: () => START,
    });
    const computerLookup = await lookupUserCode({
      store,
      userCode: computer.userCode,
      now: () => START,
    });
    expect(computerLookup.found && computerLookup.external).toBeFalsy();
    const cli = await externalGrant(store);
    expect(await lookupUserCode({ store, userCode: cli.userCode, now: () => START })).toEqual({
      found: false,
      reason: "unknown",
    });
  });
});

describe("approving a coforge-cli code", () => {
  test("the Agent's owner approves and the Agent and Workspace are recorded", async () => {
    const { store, rows } = memoryStore();
    const grant = await externalGrant(store);
    const result = await approveUserCode({
      store,
      userCode: grant.userCode,
      userId: OWNER,
      now: () => START + 1000,
      directory: directory(),
    });
    expect(result.found).toBe(true);
    const [row] = [...rows.values()];
    expect(row).toMatchObject({
      status: "approved",
      userId: OWNER,
      approvedAgentId: AGENT_ID,
      approvedWorkspaceId: WORKSPACE_ID,
    });
  });

  test.each(["not_authorized", "agent_not_external", "agent_unavailable"] as const)(
    "a %s refusal leaves the grant pending",
    async (refusal) => {
      const { store, rows } = memoryStore();
      const grant = await externalGrant(store);
      const result = await approveUserCode({
        store,
        userCode: grant.userCode,
        userId: STRANGER,
        now: () => START + 1000,
        directory: directory({ refusal: () => refusal }),
      });
      expect(result).toEqual({ found: false, reason: refusal });
      expect([...rows.values()][0]!.status).toBe("pending");
    },
  );

  test("a person who is not allowed is refused by the directory", async () => {
    const { store } = memoryStore();
    const grant = await externalGrant(store);
    expect(
      await approveUserCode({
        store,
        userCode: grant.userCode,
        userId: STRANGER,
        now: () => START + 1000,
        directory: directory(),
      }),
    ).toEqual({ found: false, reason: "not_authorized" });
  });

  test("a cli code can be denied with the directory", async () => {
    const { store } = memoryStore();
    const grant = await externalGrant(store);
    expect(
      (
        await denyUserCode({
          store,
          userCode: grant.userCode,
          userId: OWNER,
          now: () => START,
          directory: directory(),
        })
      ).found,
    ).toBe(true);
    expect(
      await pollDeviceToken({
        store,
        deviceCode: grant.deviceCode,
        now: () => START + 10_000,
        clientId: "coforge-cli",
        environment,
      }),
    ).toEqual({ status: "error", error: "access_denied" });
  });
});

describe("the token endpoint", () => {
  async function approvedCode(store: DeviceAuthorizationStore) {
    const grant = await externalGrant(store);
    await approveUserCode({
      store,
      userCode: grant.userCode,
      userId: OWNER,
      now: () => START + 1000,
      directory: directory(),
    });
    return grant;
  }

  test("an approved cli code mints one Agent key and no access token", async () => {
    const { store } = memoryStore();
    const { credentials, external } = deps();
    const grant = await approvedCode(store);
    const outcome = await pollDeviceToken({
      store,
      deviceCode: grant.deviceCode,
      now: () => START + 20_000,
      clientId: "coforge-cli",
      external,
      environment,
    });
    if (outcome.status !== "authorized_external_agent") throw new Error(JSON.stringify(outcome));
    expect(isExternalAgentKeyShape(outcome.apiKey)).toBe(true);
    expect(outcome).not.toHaveProperty("accessToken");
    expect(outcome).toMatchObject({
      agentId: AGENT_ID,
      agentName: "scout",
      workspaceId: WORKSPACE_ID,
      workspaceSlug: "acme",
    });
    expect(outcome.credentialId).toBe([...credentials.rows.values()][0]!.id);
    expect([...credentials.rows.values()][0]!.machine).toEqual({
      machineName: "laptop",
      hostname: "mac.local",
      os: "darwin",
      clientName: "coforge 1.0",
    });
    const replay = await pollDeviceToken({
      store,
      deviceCode: grant.deviceCode,
      now: () => START + 40_000,
      clientId: "coforge-cli",
      external,
      environment,
    });
    expect(replay).toEqual({ status: "error", error: "invalid_grant" });
    expect(credentials.rows.size).toBe(1);
  });

  test("a computer client cannot redeem a cli code, and the code survives the attempt", async () => {
    const { store } = memoryStore();
    const { credentials, external } = deps();
    const grant = await approvedCode(store);
    expect(
      await pollDeviceToken({
        store,
        deviceCode: grant.deviceCode,
        now: () => START + 20_000,
        environment,
      }),
    ).toEqual({ status: "error", error: "invalid_grant" });
    expect(credentials.rows.size).toBe(0);
    const outcome = await pollDeviceToken({
      store,
      deviceCode: grant.deviceCode,
      now: () => START + 40_000,
      clientId: "coforge-cli",
      external,
      environment,
    });
    expect(outcome.status).toBe("authorized_external_agent");
  });

  test("a cli client cannot redeem a Computer code", async () => {
    const { store } = memoryStore();
    const { external } = deps();
    const grant = await authorizeDevice({
      store,
      origin: "https://example.test",
      now: () => START,
    });
    await approveUserCode({
      store,
      userCode: grant.userCode,
      userId: OWNER,
      now: () => START + 1000,
    });
    expect(
      await pollDeviceToken({
        store,
        deviceCode: grant.deviceCode,
        now: () => START + 20_000,
        clientId: "coforge-cli",
        external,
        environment,
      }),
    ).toEqual({ status: "error", error: "invalid_grant" });
    const computer = await pollDeviceToken({
      store,
      deviceCode: grant.deviceCode,
      now: () => START + 40_000,
      environment,
    });
    expect(computer.status).toBe("authorized");
  });

  test("a refused mint answers access_denied with the reason", async () => {
    const { store } = memoryStore();
    const { credentials, external } = deps();
    const grant = await approvedCode(store);
    credentials.agents.get(AGENT_ID)!.stoppedAt = new Date();
    expect(
      await pollDeviceToken({
        store,
        deviceCode: grant.deviceCode,
        now: () => START + 20_000,
        clientId: "coforge-cli",
        external,
        environment,
      }),
    ).toEqual({ status: "error", error: "access_denied", coforgeCode: "agent_unavailable" });
  });

  test("the eleventh live key is refused as credential_limit", async () => {
    const { store } = memoryStore();
    const { credentials, external } = deps();
    for (let index = 0; index < 10; index++)
      await credentials.mint({
        agentId: AGENT_ID,
        workspaceId: WORKSPACE_ID,
        approvedByUserId: null,
        keyHash: `hash-${index}`,
        machine: { machineName: "m", hostname: "h", os: "o", clientName: "c" },
        maxLive: 10,
      });
    const grant = await approvedCode(store);
    expect(
      await pollDeviceToken({
        store,
        deviceCode: grant.deviceCode,
        now: () => START + 20_000,
        clientId: "coforge-cli",
        external,
        environment,
      }),
    ).toEqual({ status: "error", error: "access_denied", coforgeCode: "credential_limit" });
  });

  test("an approver who lost the right before the poll gets no key, and the grant ends", async () => {
    const { store, rows } = memoryStore();
    let allowed = true;
    const { credentials, external } = deps({
      refusal: () => (allowed ? undefined : "not_authorized"),
    });
    const grant = await approvedCode(store);
    allowed = false;
    expect(
      await pollDeviceToken({
        store,
        deviceCode: grant.deviceCode,
        now: () => START + 20_000,
        clientId: "coforge-cli",
        external,
        environment,
      }),
    ).toEqual({ status: "error", error: "access_denied", coforgeCode: "not_authorized" });
    expect(credentials.rows.size).toBe(0);
    expect([...rows.values()][0]!.status).toBe("consumed");
  });
});
