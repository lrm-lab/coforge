import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentAttentionDecisionStore } from "#src/persistence/agent-attention-decision-store";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("appends decisions per agent and reads them back in order", () => {
  const root = join(tmpdir(), `coforge-attention-journal-${crypto.randomUUID()}`);
  roots.push(root);
  const store = new AgentAttentionDecisionStore(root);
  const base = { deliveryId: "d", target: "#t", sequence: 1 };
  store.append({ ...base, at: "2026-10-22T00:00:00Z", agentId: "agent-1", messageId: "m1", outcome: "held" });
  store.append({ ...base, at: "2026-10-22T00:00:01Z", agentId: "agent-1", messageId: "m1", outcome: "notified" });
  store.append({ ...base, at: "2026-10-22T00:00:02Z", agentId: "agent-2", messageId: "m2", outcome: "consumed" });
  expect(store.read("agent-1").map((row) => row.outcome)).toEqual(["held", "notified"]);
  expect(store.read("agent-2").map((row) => row.messageId)).toEqual(["m2"]);
  expect(store.read("agent-3")).toEqual([]);
});
