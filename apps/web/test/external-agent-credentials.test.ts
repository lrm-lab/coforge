import { expect, test, spyOn } from "bun:test";
import {
  EXTERNAL_LAST_USED_INTERVAL_MS,
  ExternalCredentialError,
  MAX_LIVE_EXTERNAL_CREDENTIALS,
  authenticateExternalAgentKey,
  hashExternalAgentKey,
  isExternalAgentKeyShape,
  mintExternalAgentCredential,
  revokeAllExternalCredentials,
  revokeOneExternalCredential,
  revokeSelfExternalCredential,
} from "#src/server/agents/external-agent-credentials.server";
import { isAgentApiKeyShape } from "#src/server/agents/agent-api-key.server";
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

test("lastUsedAt is written at most once an hour", async () => {
  const repository = setup();
  const { apiKey } = await mint(repository);
  const start = Date.parse("2026-11-16T00:00:00Z");
  await authenticateExternalAgentKey(apiKey, repository, () => start);
  await authenticateExternalAgentKey(apiKey, repository, () => start + 60_000);
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

test("revoke-all revokes every live key with its reason, and one revoke stays inside its Agent", async () => {
  const repository = setup();
  repository.addAgent("agent-2");
  const first = await mint(repository);
  await mint(repository);
  expect(
    await revokeOneExternalCredential(repository, {
      credentialId: first.credentialId,
      agentId: "agent-2",
      workspaceId: WORKSPACE,
      actorUserId: "admin-1",
    }),
  ).toBe(false);
  expect(
    await revokeAllExternalCredentials(repository, {
      agentId: AGENT,
      workspaceId: WORKSPACE,
      reason: "agent_deleted",
      actorUserId: "admin-1",
    }),
  ).toBe(2);
  const listed = await repository.list(AGENT);
  expect(listed.map((row) => row.revokedReason)).toEqual(["agent_deleted", "agent_deleted"]);
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
