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
  externalGrantOf,
  parseExternalAuthorizeBody,
  type ExternalAgentDeviceDeps,
  type ExternalAgentDeviceDirectory,
} from "#src/server/auth/device-auth-external-agent.server";
import {
  isExternalAgentKeyShape,
  MAX_LIVE_EXTERNAL_CREDENTIALS,
} from "#src/server/agents/external-agent-credentials.server";
import { NO_EXTERNAL_MINT_RATE_LIMITS } from "#src/server/agents/external-agent-mint-rate-limit.server";
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
    async target(agentId) {
      return agentId === AGENT_ID
        ? { workspaceId: WORKSPACE_ID, hosting: overrides.hosting ?? "external" }
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
    async approvable(userId) {
      return userId === OWNER
        ? [
            {
              agentId: AGENT_ID,
              name: "scout",
              displayName: "Scout",
              workspaceId: WORKSPACE_ID,
              workspaceName: "Acme",
              workspaceSlug: "acme",
            },
          ]
        : [];
    },
  };
}

function deps(overrides: Parameters<typeof directory>[0] = {}) {
  const credentials = new MemoryExternalAgentCredentials();
  credentials.addAgent(AGENT_ID);
  return {
    credentials,
    external: {
      directory: directory(overrides),
      credentials,
      mintLimits: NO_EXTERNAL_MINT_RATE_LIMITS,
    } satisfies ExternalAgentDeviceDeps,
  };
}

const BODY = new URLSearchParams({
  client_id: "coforge-cli",
  machine_name: "laptop",
  hostname: "mac.local",
  os: "darwin",
  client_name: "coforge 1.0",
});

async function externalGrant(store: DeviceAuthorizationStore) {
  return authorizeDevice({
    store,
    origin: "https://example.test",
    now: () => START,
    clientId: EXTERNAL_DEVICE_CLIENT_ID,
    grant: externalGrantOf(parseExternalAuthorizeBody(BODY)!),
  });
}

const MACHINE = {
  machineName: "laptop",
  hostname: "mac.local",
  os: "darwin",
  clientName: "coforge 1.0",
};

function approve(
  store: DeviceAuthorizationStore,
  userCode: string,
  over: Partial<Parameters<typeof approveUserCode>[0]> = {},
) {
  return approveUserCode({
    store,
    userCode,
    userId: OWNER,
    agentId: AGENT_ID,
    now: () => START + 1000,
    directory: directory(),
    ...over,
  });
}

describe("coforge-cli authorize", () => {
  test("every machine field is required and bounded; no Agent or Workspace is read", () => {
    expect(parseExternalAuthorizeBody(BODY)).toEqual({ machine: MACHINE });
    const named = new URLSearchParams(BODY);
    named.set("workspace", "acme");
    named.set("agent", "scout");
    expect(parseExternalAuthorizeBody(named)).toEqual({ machine: MACHINE });
    for (const field of ["machine_name", "hostname", "os", "client_name"]) {
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

  test("the grant is stored with the client id and the machine only, and carries no verification_uri_complete", async () => {
    const { store, rows } = memoryStore();
    const grant = await externalGrant(store);
    expect(grant).not.toHaveProperty("verificationUriComplete");
    const [row] = [...rows.values()];
    expect(row!.clientId).toBe("coforge-cli");
    expect(row!.grant).toEqual({ kind: "external_agent", machine: MACHINE });
  });
});

describe("the approval page lookup", () => {
  test("any signed-in person gets the machine and no Agent, and a code with nobody signed in is unknown", async () => {
    const { store } = memoryStore();
    const grant = await externalGrant(store);
    for (const userId of [OWNER, STRANGER])
      expect(
        await lookupUserCode({ store, userCode: grant.userCode, userId, now: () => START }),
      ).toMatchObject({ found: true, external: { kind: "external_agent", machine: MACHINE } });
    expect(await lookupUserCode({ store, userCode: grant.userCode, now: () => START })).toEqual({
      found: false,
      reason: "unknown",
    });
  });

  test("a Computer code has no grant details", async () => {
    const { store } = memoryStore();
    const computer = await authorizeDevice({
      store,
      origin: "https://example.test",
      now: () => START,
    });
    const lookup = await lookupUserCode({
      store,
      userCode: computer.userCode,
      now: () => START,
    });
    expect(lookup.found && lookup.external).toBeFalsy();
  });

  test("a person over the mint limit sees mint_rate_limited", async () => {
    const { store } = memoryStore();
    const grant = await externalGrant(store);
    const refusing = {
      admit: async () => ({ allowed: true as const }),
      peek: async () => ({ allowed: false as const, retryAfterSeconds: 120 }),
    };
    expect(
      await lookupUserCode({
        store,
        userCode: grant.userCode,
        userId: OWNER,
        now: () => START,
        mintLimits: { person: refusing, agent: refusing },
      }),
    ).toEqual({ found: false, reason: "mint_rate_limited" });
  });
});

describe("approving a coforge-cli code with a chosen Agent", () => {
  test("the owner approves and the chosen Agent and its Workspace are recorded", async () => {
    const { store, rows } = memoryStore();
    const grant = await externalGrant(store);
    expect((await approve(store, grant.userCode)).found).toBe(true);
    expect([...rows.values()][0]).toMatchObject({
      status: "approved",
      userId: OWNER,
      approvedAgentId: AGENT_ID,
      approvedWorkspaceId: WORKSPACE_ID,
    });
  });

  test("no choice, an unknown Agent and a managed Agent are agent_not_found or agent_not_external and leave the grant pending", async () => {
    const { store, rows } = memoryStore();
    const grant = await externalGrant(store);
    expect(await approve(store, grant.userCode, { agentId: undefined })).toEqual({
      found: false,
      reason: "agent_not_found",
    });
    expect(await approve(store, grant.userCode, { agentId: "other" })).toEqual({
      found: false,
      reason: "agent_not_found",
    });
    expect(
      await approve(store, grant.userCode, { directory: directory({ hosting: "managed" }) }),
    ).toEqual({ found: false, reason: "agent_not_external" });
    expect([...rows.values()][0]!.status).toBe("pending");
  });

  test.each(["not_authorized", "agent_unavailable", "credential_limit"] as const)(
    "a %s refusal leaves the grant pending",
    async (refusal) => {
      const { store, rows } = memoryStore();
      const grant = await externalGrant(store);
      expect(
        await approve(store, grant.userCode, {
          directory: directory({ refusal: () => refusal }),
        }),
      ).toEqual({ found: false, reason: refusal });
      expect([...rows.values()][0]!.status).toBe("pending");
    },
  );

  test("a person who may not manage the Agent is refused", async () => {
    const { store } = memoryStore();
    const grant = await externalGrant(store);
    expect(await approve(store, grant.userCode, { userId: STRANGER })).toEqual({
      found: false,
      reason: "not_authorized",
    });
  });

  test("the chosen Agent's mint budget is checked and the grant stays pending", async () => {
    const { store, rows } = memoryStore();
    const grant = await externalGrant(store);
    const asked: string[] = [];
    const agentLimit = {
      admit: async () => ({ allowed: true as const }),
      peek: async (id: string) => {
        asked.push(id);
        return { allowed: false as const, retryAfterSeconds: 60 };
      },
    };
    expect(
      await approve(store, grant.userCode, {
        mintLimits: { person: NO_EXTERNAL_MINT_RATE_LIMITS.person, agent: agentLimit },
      }),
    ).toEqual({ found: false, reason: "mint_rate_limited" });
    expect(asked).toEqual([AGENT_ID]);
    expect([...rows.values()][0]!.status).toBe("pending");
  });

  test("a cli code can be denied without choosing an Agent", async () => {
    const { store } = memoryStore();
    const grant = await externalGrant(store);
    expect(
      (await denyUserCode({ store, userCode: grant.userCode, userId: OWNER, now: () => START }))
        .found,
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

  test("the Agents an approver may choose come from the directory", async () => {
    expect(await directory().approvable(OWNER)).toHaveLength(1);
    expect(await directory().approvable(STRANGER)).toEqual([]);
  });
});

describe("the token endpoint", () => {
  async function approvedCode(store: DeviceAuthorizationStore) {
    const grant = await externalGrant(store);
    await approve(store, grant.userCode);
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

  test("a redeem over the mint limit answers access_denied with the wait", async () => {
    const { store } = memoryStore();
    const { credentials, external } = deps();
    const grant = await approvedCode(store);
    const refusing = {
      admit: async () => ({ allowed: false as const, retryAfterSeconds: 240 }),
      peek: async () => ({ allowed: true as const }),
    };
    expect(
      await pollDeviceToken({
        store,
        deviceCode: grant.deviceCode,
        now: () => START + 20_000,
        clientId: "coforge-cli",
        external: { ...external, mintLimits: { person: refusing, agent: refusing } },
        environment,
      }),
    ).toEqual({
      status: "error",
      error: "access_denied",
      coforgeCode: "agent_credential_mint_rate_limited",
      retryAfterSeconds: 240,
    });
    expect(credentials.rows.size).toBe(0);
  });

  test("the fifty-first live key is refused as credential_limit", async () => {
    const { store } = memoryStore();
    const { credentials, external } = deps();
    for (let index = 0; index < MAX_LIVE_EXTERNAL_CREDENTIALS; index++)
      await credentials.mint({
        agentId: AGENT_ID,
        workspaceId: WORKSPACE_ID,
        approvedByUserId: null,
        keyHash: `hash-${index}`,
        source: "device",
        machine: { machineName: "m", hostname: "h", os: "o", clientName: "c" },
        maxLive: MAX_LIVE_EXTERNAL_CREDENTIALS,
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
