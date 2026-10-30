import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentContextLedger } from "#src/persistence/agent-context-ledger";
import { AgentStateDb } from "#src/persistence/agent-state-db";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function open(root = join(tmpdir(), `coforge-context-ledger-${crypto.randomUUID()}`)) {
  if (!directories.includes(root)) directories.push(root);
  const stateDb = AgentStateDb.open(root, "agent-1");
  return { root, stateDb, ledger: new AgentContextLedger(stateDb.database) };
}

test("a revision is shown on its first appearance in a context and not again", () => {
  const { ledger } = open();
  expect(ledger.claim("sender", "agent:ada", "r1")).toBe(true);
  expect(ledger.claim("sender", "agent:ada", "r1")).toBe(false);
  expect(ledger.claim("sender", "agent:bob", "r1")).toBe(true);
});

test("a changed revision is shown again, and the kinds do not share ids", () => {
  const { ledger } = open();
  ledger.claim("sender", "x", "r1");
  expect(ledger.claim("sender", "x", "r2")).toBe(true);
  expect(ledger.claim("sender", "x", "r2")).toBe(false);
  expect(ledger.claim("channel", "x", "r2")).toBe(true);
});

test("a new context shows everything again", () => {
  const { ledger } = open();
  ledger.claim("sender", "x", "r1");
  ledger.advance();
  expect(ledger.claim("sender", "x", "r1")).toBe(true);
});

test("the context number and the claims survive a reopen", () => {
  const first = open();
  first.ledger.advance();
  first.ledger.claim("sender", "x", "r1");
  first.stateDb.close();
  const { ledger } = open(first.root);
  expect(ledger.generation()).toBe(1);
  expect(ledger.claim("sender", "x", "r1")).toBe(false);
  expect(ledger.advance()).toBe(2);
});
