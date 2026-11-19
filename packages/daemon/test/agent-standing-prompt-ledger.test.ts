import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentContexts } from "#src/daemon-runtime/agent-contexts";
import { prepareAgentLaunch } from "#src/agent-runtime/agent-launch-preparation";
import { AgentStandingPromptLedger } from "#src/persistence/agent-standing-prompt-ledger";
import { AgentStateDb, readMeta, writeMeta } from "#src/persistence/agent-state-db";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function open(root = join(tmpdir(), `coforge-standing-prompt-${crypto.randomUUID()}`)) {
  if (!directories.includes(root)) directories.push(root);
  const stateDb = AgentStateDb.open(root, "agent-1");
  return { root, stateDb, ledger: new AgentStandingPromptLedger(stateDb.database) };
}

test("records standing prompt hash and metadata across reopen without storing raw prompt text", () => {
  const first = open();
  const secretPhrase = "Standing instructions with UTF-8 中文 and unique marker";
  const written = first.ledger.record({
    instructions: secretPhrase,
    provider: "antigravity",
    sessionId: "sess-1",
    nowMs: 1_700_000_000_000,
  });
  expect(written.isFirst).toBe(true);
  expect(written.changed).toBe(false);
  expect(written.written).toBe(true);
  expect(written.previous).toBeUndefined();
  expect(written.record.bytes).toBe(Buffer.byteLength(secretPhrase, "utf8"));
  expect(written.record.provider).toBe("antigravity");
  expect(written.record.sessionId).toBe("sess-1");
  expect(written.record.recordedAtMs).toBe(1_700_000_000_000);
  const rawMeta = readMeta(first.stateDb.database, "standingPrompt");
  expect(rawMeta).toBeDefined();
  expect(rawMeta).not.toContain(secretPhrase);
  first.stateDb.close();

  const second = open(first.root);
  expect(second.ledger.read()).toEqual(written.record);
  second.stateDb.close();
});

test("skips redundant writes when unchanged and reports drift when instructions change", () => {
  const { stateDb, ledger } = open();
  const initial = ledger.record({
    instructions: "v1 instructions",
    provider: "antigravity",
    sessionId: "sess-1",
    nowMs: 1_000,
  });
  const repeat = ledger.record({
    instructions: "v1 instructions",
    provider: "antigravity",
    sessionId: "sess-1",
    nowMs: 2_000,
  });
  expect(repeat.written).toBe(false);
  expect(repeat.changed).toBe(false);
  expect(repeat.isFirst).toBe(false);
  expect(repeat.record.recordedAtMs).toBe(1_000);

  const sessionAttached = ledger.record({
    instructions: "v1 instructions",
    provider: "antigravity",
    sessionId: "sess-2",
    nowMs: 2_500,
  });
  expect(sessionAttached.written).toBe(true);
  expect(sessionAttached.changed).toBe(false);
  expect(sessionAttached.record.sessionId).toBe("sess-2");

  const updated = ledger.record({
    instructions: "v2 instructions updated",
    provider: "antigravity",
    sessionId: "sess-2",
    nowMs: 3_000,
  });
  expect(updated.written).toBe(true);
  expect(updated.changed).toBe(true);
  expect(updated.isFirst).toBe(false);
  expect(updated.previous?.hash).toBe(initial.record.hash);
  expect(updated.record.hash).not.toBe(initial.record.hash);
  stateDb.close();
});

test("diff inspects drift without mutating state and clear removes the stored record", () => {
  const { stateDb, ledger } = open();
  expect(ledger.diff("prompt-a")).toMatchObject({ isFirst: true, changed: false });
  expect(ledger.read()).toBeUndefined();

  ledger.record({ instructions: "prompt-a", provider: "codex", nowMs: 100 });
  expect(ledger.diff("prompt-a")).toMatchObject({ isFirst: false, changed: false });
  expect(ledger.diff("prompt-b")).toMatchObject({ isFirst: false, changed: true });
  expect(ledger.read()?.bytes).toBe(Buffer.byteLength("prompt-a", "utf8"));

  ledger.clear();
  expect(ledger.read()).toBeUndefined();
  stateDb.close();
});

test("corrupt meta value is ignored safely and overwritten by the next record", () => {
  const { stateDb, ledger } = open();
  writeMeta(stateDb.database, "standingPrompt", "{not-json");
  expect(ledger.read()).toBeUndefined();

  writeMeta(stateDb.database, "standingPrompt", JSON.stringify({ hash: "", bytes: -1 }));
  expect(ledger.read()).toBeUndefined();

  const recovered = ledger.record({
    instructions: "recovered prompt",
    provider: "claude",
    nowMs: 500,
  });
  expect(recovered.isFirst).toBe(true);
  expect(ledger.read()).toEqual(recovered.record);
  stateDb.close();
});

test("AgentContexts persists standing prompts and stays best-effort when stateDb throws", () => {
  const root = join(tmpdir(), `coforge-contexts-prompt-${crypto.randomUUID()}`);
  directories.push(root);
  const dbs = new Map<string, AgentStateDb>();
  const contexts = new AgentContexts((agentId) => {
    const existing = dbs.get(agentId);
    if (existing) return existing;
    const opened = AgentStateDb.open(root, agentId);
    dbs.set(agentId, opened);
    return opened;
  });
  const first = contexts.recordStandingPrompt("agent-1", {
    instructions: "base prompt",
    provider: "antigravity",
    sessionId: "s-1",
    resumed: false,
    nowMs: 10,
  });
  expect(first?.isFirst).toBe(true);
  expect(contexts.standingPrompt("agent-1")?.hash).toBe(first?.record.hash);

  const second = contexts.recordStandingPrompt("agent-1", {
    instructions: "updated prompt",
    provider: "antigravity",
    sessionId: "s-1",
    resumed: true,
    nowMs: 20,
  });
  expect(second?.changed).toBe(true);
  expect(contexts.standingPrompt("agent-1")?.hash).toBe(second?.record.hash);
  for (const db of dbs.values()) db.close();

  const broken = new AgentContexts(() => {
    throw new Error("disk full");
  });
  expect(broken.standingPrompt("agent-1")).toBeUndefined();
  expect(
    broken.recordStandingPrompt("agent-1", {
      instructions: "prompt",
      provider: "antigravity",
    }),
  ).toBeUndefined();
});

test("prepareAgentLaunch reports built standing instructions through onInstructions", async () => {
  const workspaceDir = join(tmpdir(), `coforge-launch-prep-${crypto.randomUUID()}`);
  directories.push(workspaceDir);
  let captured: string | undefined;
  const options = await prepareAgentLaunch(
    {
      agentId: "agent-1",
      config: {
        provider: "antigravity",
        model: "gemini-3-flash",
        reasoning: "medium",
      },
      agentWorkspaceDirectory: workspaceDir,
      environment: { COFORGE_EVAL_DISABLE_HOST_PI_INJECTION: "1" },
      onInstructions: (instructions) => {
        captured = instructions;
      },
    },
    {
      createProvider: () => {
        throw new Error("unused");
      },
      resolveGitHooks: async () => undefined,
    },
  );
  expect(captured).toBe(options.instructions);
  expect(captured?.length ?? 0).toBeGreaterThan(0);
});
