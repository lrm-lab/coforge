import { beforeEach, describe, expect, test, spyOn } from "bun:test";
import {
  EXTERNAL_LAST_USED_INTERVAL_MS,
  ExternalCredentialError,
  MAX_LIVE_EXTERNAL_CREDENTIALS,
  issueExternalAgentPageCredential,
  authenticateExternalAgentKey,
  hashExternalAgentKey,
  isExternalAgentKeyShape,
  mintExternalAgentCredential,
  revokeOneExternalCredential,
  revokeSelfExternalCredential,
} from "#src/server/agents/external-agent-credentials.server";
import { isAgentApiKeyShape } from "#src/server/agents/agent-api-key.server";
import {
  EXTERNAL_ONLINE_WINDOW_MS,
  externalSetups,
} from "#src/server/agents/external-agent-presence.server";
import { MemoryExternalAgentCredentials } from "./helpers/memory-external-agent-credentials";

const AGENT = "agent-1";
const WORKSPACE = "workspace-1";
const MACHINE = { machineName: "laptop", hostname: "mac.local", os: "darwin", clientName: "cli" };

function setup(overrides = {}) {
  const repository = new MemoryExternalAgentCredentials();
  repository.addAgent(AGENT, overrides);
  return repository;
}

async function mint(repository: MemoryExternalAgentCredentials) {
  const minted = await mintExternalAgentCredential({
    repository,
    agentId: AGENT,
    workspaceId: WORKSPACE,
    approvedByUserId: "user-1",
    source: "device",
    machine: MACHINE,
  });
  if (!minted.ok) throw new Error(`mint refused: ${minted.reason}`);
  return minted;
}

async function failure(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ExternalCredentialError);
  return (error as ExternalCredentialError).reason;
}

test("a minted key is sk_ext_ shaped, never an Agent API key, and stored only as a hash", async () => {
  const repository = setup();
  const { apiKey } = await mint(repository);
  expect(isExternalAgentKeyShape(apiKey)).toBe(true);
  expect(isAgentApiKeyShape(apiKey)).toBe(false);
  expect([...repository.rows.keys()]).toEqual([hashExternalAgentKey(apiKey)]);
  expect(JSON.stringify([...repository.rows.values()])).not.toContain(apiKey);
});

test("a presented key authenticates to the Agent's owner with no Computer", async () => {
  const repository = setup();
  const { apiKey, credentialId } = await mint(repository);
  expect(await authenticateExternalAgentKey(apiKey, repository)).toEqual({
    external: true,
    userId: "owner-1",
    workspaceId: WORKSPACE,
    computerId: "",
    agentId: AGENT,
    credentialId,
  });
});

test("malformed, unknown and sk_agent_ keys are not found", async () => {
  const repository = setup();
  await mint(repository);
  expect(await failure(authenticateExternalAgentKey("sk_ext_short", repository))).toBe(
    "key_not_found",
  );
  expect(await failure(authenticateExternalAgentKey(`sk_ext_${"a".repeat(43)}`, repository))).toBe(
    "key_not_found",
  );
  expect(
    await failure(authenticateExternalAgentKey(`sk_agent_${"a".repeat(43)}`, repository)),
  ).toBe("key_not_found");
});

test("a revoked key, a stopped, deleted or managed Agent no longer authenticates", async () => {
  const repository = setup();
  const { apiKey, credentialId } = await mint(repository);
  const agent = repository.agents.get(AGENT)!;

  agent.stoppedAt = new Date();
  expect(await failure(authenticateExternalAgentKey(apiKey, repository))).toBe("agent_unavailable");
  agent.stoppedAt = null;
  agent.deletedAt = new Date();
  expect(await failure(authenticateExternalAgentKey(apiKey, repository))).toBe("agent_unavailable");
  agent.deletedAt = null;
  agent.hosting = "managed";
  expect(await failure(authenticateExternalAgentKey(apiKey, repository))).toBe("agent_unavailable");
  agent.hosting = "external";

  expect(
    await revokeSelfExternalCredential(repository, {
      credentialId,
      agentId: AGENT,
      workspaceId: WORKSPACE,
    }),
  ).toBe(true);
  expect(await failure(authenticateExternalAgentKey(apiKey, repository))).toBe("key_revoked");
  expect(
    await revokeSelfExternalCredential(repository, {
      credentialId,
      agentId: AGENT,
      workspaceId: WORKSPACE,
    }),
  ).toBe(false);
});

test("lastUsedAt is written at most once every 30 seconds", async () => {
  const repository = setup();
  const { apiKey } = await mint(repository);
  const start = Date.parse("2026-11-16T00:00:00Z");
  await authenticateExternalAgentKey(apiKey, repository, () => start);
  await authenticateExternalAgentKey(apiKey, repository, () => start + 10_000);
  await authenticateExternalAgentKey(
    apiKey,
    repository,
    () => start + EXTERNAL_LAST_USED_INTERVAL_MS - 1,
  );
  expect(repository.touches).toBe(1);
  await authenticateExternalAgentKey(
    apiKey,
    repository,
    () => start + EXTERNAL_LAST_USED_INTERVAL_MS,
  );
  expect(repository.touches).toBe(2);
});

test("being seen is reported only when the lastUsedAt write is due", async () => {
  const repository = setup();
  const { apiKey } = await mint(repository);
  const start = Date.parse("2026-11-16T00:00:00Z");
  const seen: { agent: unknown; at: number }[] = [];
  const onSeen = async (agent: unknown, at: number) => {
    seen.push({ agent, at });
  };
  await authenticateExternalAgentKey(apiKey, repository, () => start, onSeen);
  await authenticateExternalAgentKey(apiKey, repository, () => start + 10_000, onSeen);
  expect(seen).toEqual([
    { agent: { workspaceId: WORKSPACE, agentId: AGENT, visibility: "public" }, at: start },
  ]);
  await authenticateExternalAgentKey(
    apiKey,
    repository,
    () => start + EXTERNAL_LAST_USED_INTERVAL_MS,
    onSeen,
  );
  expect(seen.map((entry) => entry.at)).toEqual([start, start + EXTERNAL_LAST_USED_INTERVAL_MS]);
});

test("a failing seen report does not fail the request", async () => {
  const repository = setup();
  const { apiKey } = await mint(repository);
  const principal = await authenticateExternalAgentKey(apiKey, repository, Date.now, async () => {
    throw new Error("redis down");
  });
  expect(principal.agentId).toBe(AGENT);
});

test("a failed lastUsedAt write does not fail the request", async () => {
  const repository = setup();
  const { apiKey } = await mint(repository);
  repository.touch = async () => {
    throw new Error("database down");
  };
  expect((await authenticateExternalAgentKey(apiKey, repository)).agentId).toBe(AGENT);
});

test("minting is refused for an Agent that is gone, stopped, managed or at the key limit", async () => {
  const refusal = async (repository: MemoryExternalAgentCredentials) => {
    const minted = await mintExternalAgentCredential({
      repository,
      agentId: AGENT,
      workspaceId: WORKSPACE,
      approvedByUserId: null,
      source: "device",
      machine: MACHINE,
    });
    return minted.ok ? "ok" : minted.reason;
  };
  expect(await refusal(new MemoryExternalAgentCredentials())).toBe("agent_unavailable");
  expect(await refusal(setup({ stoppedAt: new Date() }))).toBe("agent_unavailable");
  expect(await refusal(setup({ deletedAt: new Date() }))).toBe("agent_unavailable");
  expect(await refusal(setup({ hosting: "managed" }))).toBe("agent_not_external");

  const full = setup();
  for (let index = 0; index < MAX_LIVE_EXTERNAL_CREDENTIALS; index++) await mint(full);
  expect(await refusal(full)).toBe("credential_limit");
  const [first] = await full.list(AGENT);
  await revokeOneExternalCredential(full, {
    credentialId: first!.id,
    agentId: AGENT,
    workspaceId: WORKSPACE,
    actorUserId: "admin-1",
  });
  expect(await refusal(full)).toBe("ok");
});

test("one revoke stays inside its Agent, and the list never carries key material", async () => {
  const repository = setup();
  repository.addAgent("agent-2");
  const first = await mint(repository);
  expect(
    await revokeOneExternalCredential(repository, {
      credentialId: first.credentialId,
      agentId: "agent-2",
      workspaceId: WORKSPACE,
      actorUserId: "admin-1",
    }),
  ).toBe(false);
  const listed = await repository.list(AGENT);
  expect(listed.map((row) => row.revokedReason)).toEqual([null]);
  expect(Object.keys(listed[0]!)).not.toContain("keyHash");
});

test("audit lines never carry key material", async () => {
  const info = spyOn(console, "info").mockImplementation(() => {});
  try {
    const repository = setup();
    const { apiKey, credentialId } = await mint(repository);
    await revokeSelfExternalCredential(repository, {
      credentialId,
      agentId: AGENT,
      workspaceId: WORKSPACE,
    });
    const lines = info.mock.calls.map((call) => String(call[0]));
    expect(lines.length).toBe(2);
    expect(lines.join("\n")).not.toContain(apiKey);
    expect(lines.join("\n")).not.toContain(hashExternalAgentKey(apiKey));
    expect(JSON.parse(lines[0]!).event).toBe("external_agent.credential_issued");
  } finally {
    info.mockRestore();
  }
});

async function issuePage(repository: MemoryExternalAgentCredentials) {
  return issueExternalAgentPageCredential({
    repository,
    agentId: AGENT,
    workspaceId: WORKSPACE,
    actorUserId: "user-1",
  });
}

test("the live-credential limit is 50", () => {
  expect(MAX_LIVE_EXTERNAL_CREDENTIALS).toBe(50);
});

test("a page credential replaces the live one, leaves device credentials alone and has no machine", async () => {
  const repository = setup();
  const device = await mint(repository);
  const first = await issuePage(repository);
  expect(isExternalAgentKeyShape(first.key)).toBe(true);
  const second = await issuePage(repository);
  expect(second.credentialId).not.toBe(first.credentialId);
  const rows = await repository.list(AGENT);
  const byId = new Map(rows.map((row) => [row.id, row]));
  expect(byId.get(first.credentialId)).toMatchObject({
    source: "app",
    machineName: null,
    hostname: null,
    os: null,
    clientName: null,
    revokedReason: "replaced",
  });
  expect(byId.get(second.credentialId)).toMatchObject({ source: "app", revokedReason: null });
  expect(byId.get(device.credentialId)).toMatchObject({ source: "device", revokedAt: null });
  expect(await failure(authenticateExternalAgentKey(first.key, repository))).toBe("key_revoked");
  expect((await authenticateExternalAgentKey(second.key, repository)).agentId).toBe(AGENT);
});

test("a page credential is refused at the limit, but replaces itself when only it fills the limit", async () => {
  const full = setup();
  for (let index = 0; index < MAX_LIVE_EXTERNAL_CREDENTIALS; index++) await mint(full);
  await expect(issuePage(full)).rejects.toMatchObject({ code: "CONFLICT" });
  expect((await full.list(AGENT)).filter((row) => !row.revokedAt)).toHaveLength(
    MAX_LIVE_EXTERNAL_CREDENTIALS,
  );
  const almost = setup();
  for (let index = 0; index < MAX_LIVE_EXTERNAL_CREDENTIALS - 1; index++) await mint(almost);
  await issuePage(almost);
  await issuePage(almost);
  expect((await almost.list(AGENT)).filter((row) => !row.revokedAt)).toHaveLength(
    MAX_LIVE_EXTERNAL_CREDENTIALS,
  );
  await expect(
    issueExternalAgentPageCredential({
      repository: setup({ hosting: "managed" }),
      agentId: AGENT,
      workspaceId: WORKSPACE,
      actorUserId: "user-1",
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

describe("externalSetup", () => {
  const NOW = Date.parse("2026-11-17T12:00:00Z");
  const setupOf = async (repository: MemoryExternalAgentCredentials) =>
    (await externalSetups(repository, [AGENT], NOW)).get(AGENT);
  const use = (key: string, at: number) =>
    authenticateExternalAgentKey(key, repository(), () => at);
  let shared = new MemoryExternalAgentCredentials();
  const repository = () => shared;

  beforeEach(() => {
    shared = setup();
  });

  test("waiting with no credential or none used", async () => {
    expect(await setupOf(shared)).toEqual({ state: "waiting", lastSeenAt: null });
    await issuePage(shared);
    expect(await setupOf(shared)).toEqual({ state: "waiting", lastSeenAt: null });
  });

  test("online within two minutes of a live credential's use, offline after", async () => {
    const { key } = await issuePage(shared);
    const usedAt = NOW - EXTERNAL_ONLINE_WINDOW_MS + 1;
    await use(key, usedAt);
    expect(await setupOf(shared)).toEqual({ state: "online", lastSeenAt: new Date(usedAt) });
    const staleAt = NOW - EXTERNAL_ONLINE_WINDOW_MS;
    shared.rows.values().next().value!.lastUsedAt = new Date(staleAt);
    expect(await setupOf(shared)).toEqual({ state: "offline", lastSeenAt: new Date(staleAt) });
  });

  test("a replaced credential's unused successor is waiting, not disconnected", async () => {
    const first = await issuePage(shared);
    await use(first.key, NOW - 1000);
    await issuePage(shared);
    expect(await setupOf(shared)).toEqual({ state: "waiting", lastSeenAt: null });
  });

  test("disconnected once a used credential is revoked and none is left", async () => {
    const { key } = await issuePage(shared);
    await use(key, NOW - 1000);
    const [live] = await shared.list(AGENT);
    await revokeOneExternalCredential(shared, {
      credentialId: live!.id,
      agentId: AGENT,
      workspaceId: WORKSPACE,
      actorUserId: "admin-1",
    });
    expect(await setupOf(shared)).toEqual({
      state: "disconnected",
      lastSeenAt: new Date(NOW - 1000),
    });
  });

  test("every Agent is answered from one repository call", async () => {
    let calls = 0;
    const counting = { presence: async () => (calls++, []) };
    const states = await externalSetups(counting, ["a", "b", "c"], NOW);
    expect(calls).toBe(1);
    expect([...states.values()].map((setup) => setup.state)).toEqual([
      "waiting",
      "waiting",
      "waiting",
    ]);
  });
});
