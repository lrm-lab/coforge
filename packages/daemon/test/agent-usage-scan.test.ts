import { expect, test } from "bun:test";
import type { AgentSession, UsageSnapshot } from "@coforge/agent";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { UsageUnavailableError } from "@lrm/coforge-anvil";
import type { AgentRuntime } from "#src/agent-runtime/agent-process-manager";
import { scanAgentUsage } from "#src/daemon-runtime/agent-usage-scan";

const scope = { agentId: "agent-a", expectedRuntimeConfigRevision: 2 };
const snapshot: UsageSnapshot = {
  provider: RUNTIME_PROVIDER.CODEX,
  accountLabel: "a***@example.com",
};

function runtime(revision: number | undefined, readUsage: AgentSession["readUsage"]): AgentRuntime {
  return {
    effectiveConfigRevision: revision,
    config: { provider: RUNTIME_PROVIDER.CODEX, model: "default", reasoning: "balanced" },
    session: { readUsage } as AgentSession,
  };
}

test("Agent usage only reads a live Codex process that proves the requested revision", async () => {
  let queries = 0;
  const read = async () => {
    queries++;
    return snapshot;
  };
  let active = runtime(1, read);
  const agents = { runtime: () => active, isStopping: () => false };
  expect(await scanAgentUsage(agents, scope)).toBeUndefined();
  active = runtime(undefined, read);
  expect(await scanAgentUsage(agents, scope)).toBeUndefined();
  expect(queries).toBe(0);

  active = runtime(2, read);
  const result = await scanAgentUsage(agents, scope);
  expect(result?.effectiveRuntimeConfigRevision).toBe(2);
  expect(result?.status).toBe("available");
  expect(JSON.parse(new TextDecoder().decode(result?.snapshotJson))).toMatchObject(snapshot);
  expect(queries).toBe(1);
});

test("a Codex usage failure has no fallback and a replaced process cannot finish its scan", async () => {
  const reading = Promise.withResolvers<UsageSnapshot>();
  let active = runtime(2, () => reading.promise);
  const agents = { runtime: () => active, isStopping: () => false };
  const inflight = scanAgentUsage(agents, scope);
  active = runtime(2, async () => {
    throw new UsageUnavailableError();
  });
  reading.resolve(snapshot);
  expect(await inflight).toBeUndefined();
  expect(await scanAgentUsage(agents, scope)).toMatchObject({
    effectiveRuntimeConfigRevision: 2,
    status: "unavailable",
    accepted: false,
  });
  expect((await scanAgentUsage(agents, scope))?.snapshotJson).toBeUndefined();
});

test("an empty Codex usage snapshot is retryable without evidence of an authentication failure", async () => {
  const active = runtime(2, async () => null);
  const agents = { runtime: () => active, isStopping: () => false };
  expect(await scanAgentUsage(agents, scope)).toMatchObject({
    effectiveRuntimeConfigRevision: 2,
    status: "unavailable",
    accepted: false,
  });
});
