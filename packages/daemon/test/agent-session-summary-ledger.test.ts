import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStateDb, writeMeta } from "#src/persistence/agent-state-db";
import { AgentSessionSummaryLedger } from "#src/persistence/agent-session-summary-ledger";
import { AgentContexts } from "#src/daemon-runtime/agent-contexts";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "coforge-session-summary-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("AgentSessionSummaryLedger persists context usage across reopen and matches only the recorded session", () => {
  const db1 = AgentStateDb.open(tempDir, "agent-1");
  const ledger1 = new AgentSessionSummaryLedger(db1.database);

  expect(ledger1.read()).toBeUndefined();
  expect(ledger1.resumeFacts("sess-1")).toBeUndefined();

  const recorded = ledger1.recordContextUsage({
    sessionId: "sess-1",
    provider: "antigravity",
    usedTokens: 180_000,
    windowTokens: 1_000_000,
    observedAtMs: 1_700_000_000_000,
    nowMs: 1_700_000_001_000,
  });
  expect(recorded).toEqual({
    sessionId: "sess-1",
    provider: "antigravity",
    lastActivityAtMs: 1_700_000_000_000,
    lastContextTokens: 180_000,
    windowTokens: 1_000_000,
    updatedAtMs: 1_700_000_001_000,
  });
  db1.close();

  const db2 = AgentStateDb.open(tempDir, "agent-1");
  const ledger2 = new AgentSessionSummaryLedger(db2.database);
  expect(ledger2.resumeFacts("sess-1")).toEqual({
    lastActivityAtMs: 1_700_000_000_000,
    lastContextTokens: 180_000,
  });
  expect(ledger2.resumeFacts("sess-other")).toBeUndefined();
  db2.close();
});

test("AgentSessionSummaryLedger keeps lastActivityAtMs monotonic, resets on session switch, and handles compaction", () => {
  const db = AgentStateDb.open(tempDir, "agent-2");
  const ledger = new AgentSessionSummaryLedger(db.database);

  ledger.recordContextUsage({
    sessionId: "sess-a",
    provider: "grok",
    usedTokens: 210_000,
    windowTokens: 256_000,
    observedAtMs: 2_000,
    nowMs: 2_000,
  });

  ledger.recordContextUsage({
    sessionId: "sess-a",
    provider: "grok",
    usedTokens: 210_000,
    windowTokens: 256_000,
    observedAtMs: 1_500,
    nowMs: 2_500,
  });
  expect(ledger.read()?.lastActivityAtMs).toBe(2_000);
  expect(ledger.read()?.updatedAtMs).toBe(2_000);

  ledger.recordActivity({
    sessionId: "sess-a",
    provider: "grok",
    atMs: 5_000,
    nowMs: 5_000,
  });
  expect(ledger.resumeFacts("sess-a")).toEqual({
    lastActivityAtMs: 5_000,
    lastContextTokens: 210_000,
  });

  ledger.recordCompaction({
    sessionId: "sess-a",
    provider: "grok",
    tokensAfter: 48_000,
    windowTokens: 256_000,
    nowMs: 6_000,
  });
  expect(ledger.resumeFacts("sess-a")).toEqual({
    lastActivityAtMs: 6_000,
    lastContextTokens: 48_000,
  });

  ledger.recordCompaction({
    sessionId: "sess-a",
    provider: "grok",
    nowMs: 7_000,
  });
  expect(ledger.resumeFacts("sess-a")).toBeUndefined();
  expect(ledger.read()?.lastActivityAtMs).toBe(7_000);

  ledger.recordContextUsage({
    sessionId: "sess-a",
    provider: "grok",
    usedTokens: 190_000,
    nowMs: 8_000,
  });
  ledger.recordActivity({
    sessionId: "sess-b",
    provider: "grok",
    atMs: 9_000,
    nowMs: 9_000,
  });
  expect(ledger.resumeFacts("sess-a")).toBeUndefined();
  expect(ledger.resumeFacts("sess-b")).toBeUndefined();
  expect(ledger.read()?.sessionId).toBe("sess-b");

  db.close();
});

test("AgentSessionSummaryLedger ignores invalid inputs and recovers from corrupt meta JSON", () => {
  const db = AgentStateDb.open(tempDir, "agent-3");
  const ledger = new AgentSessionSummaryLedger(db.database);

  writeMeta(db.database, "sessionSummary", "{broken-json");
  expect(ledger.read()).toBeUndefined();
  expect(ledger.resumeFacts("sess-1")).toBeUndefined();

  expect(
    ledger.recordContextUsage({
      sessionId: "",
      provider: "opencode",
      usedTokens: 150_000,
    }),
  ).toBeUndefined();
  expect(
    ledger.recordContextUsage({
      sessionId: "sess-1",
      provider: "opencode",
      usedTokens: 0,
    }),
  ).toBeUndefined();

  ledger.recordContextUsage({
    sessionId: "sess-1",
    provider: "opencode",
    usedTokens: 150_000,
    nowMs: 10_000,
  });
  expect(ledger.resumeFacts("sess-1")).toEqual({
    lastActivityAtMs: 10_000,
    lastContextTokens: 150_000,
  });

  ledger.clear();
  expect(ledger.read()).toBeUndefined();
  db.close();
});

test("AgentContexts reads and records session summary facts best-effort", () => {
  const db = AgentStateDb.open(tempDir, "agent-4");
  const contexts = new AgentContexts(() => db);

  contexts.recordSessionContextUsage("agent-4", {
    sessionId: "pi-sess-1",
    provider: "pi",
    usedTokens: 240_000,
    windowTokens: 400_000,
    observedAtMs: 1_000,
    nowMs: 1_000,
  });
  expect(contexts.sessionResumeFacts("agent-4", "pi-sess-1")).toEqual({
    lastActivityAtMs: 1_000,
    lastContextTokens: 240_000,
  });

  contexts.recordSessionActivity("agent-4", {
    sessionId: "pi-sess-1",
    provider: "pi",
    atMs: 2_000,
    nowMs: 2_000,
  });
  expect(contexts.sessionResumeFacts("agent-4", "pi-sess-1")).toEqual({
    lastActivityAtMs: 2_000,
    lastContextTokens: 240_000,
  });

  contexts.recordSessionCompaction("agent-4", {
    sessionId: "pi-sess-1",
    provider: "pi",
    nowMs: 3_000,
  });
  expect(contexts.sessionResumeFacts("agent-4", "pi-sess-1")).toBeUndefined();

  db.close();
  expect(contexts.sessionResumeFacts("agent-4", "pi-sess-1")).toBeUndefined();
});
