import { afterEach, expect, jest, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_ERROR_CLASS } from "#src/agent-runtime/runtime-error-classification";
import { RuntimeErrorDeliveryHold } from "#src/daemon-runtime/runtime-error-delivery-hold";
import { AgentRuntimeBackoffStore } from "#src/persistence/agent-runtime-backoff-store";
import { captureDaemonLogs } from "./log-capture";
import { escapePathIdentity } from "#src/persistence/path-scope";

const HOUR_MS = 60 * 60_000;

afterEach(() => jest.useRealTimers());

async function directory() {
  return mkdtemp(join(tmpdir(), "coforge-backoff-"));
}

test("a recorded backoff survives a new store instance and is cleared when it ends", async () => {
  const state = await directory();
  try {
    // One process writes, the next one (a restart) reads.
    const writer = new AgentRuntimeBackoffStore(() => state, "process-a");
    const reader = new AgentRuntimeBackoffStore(() => state, "process-b");
    writer.save("agent-a", { untilMs: Date.now() + HOUR_MS, reason: "rate_limit_backoff" });
    expect(reader.list()).toEqual([
      { agentId: "agent-a", untilMs: expect.any(Number), reason: "rate_limit_backoff" },
    ]);
    // The writing process itself does not re-read its own record: its hold is the live authority.
    expect(writer.list()).toEqual([]);
    reader.clear("agent-a");
    expect(reader.list()).toEqual([]);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

test("an expired record and a corrupt one are both dropped instead of holding anything", async () => {
  const state = await directory();
  try {
    const agentState = join(state, "agent-state");
    await Bun.write(
      join(agentState, escapePathIdentity("agent-expired"), "runtime-backoff.json"),
      JSON.stringify({ version: 1, untilMs: Date.now() - HOUR_MS, reason: "rate_limit_backoff" }),
    );
    await Bun.write(
      join(agentState, escapePathIdentity("agent-corrupt"), "runtime-backoff.json"),
      "{not json",
    );
    const store = new AgentRuntimeBackoffStore(() => state, "previous-process");
    expect(store.list()).toEqual([]);
    for (const entry of await readdir(agentState)) {
      expect(await readdir(join(agentState, entry)).catch((): string[] => [])).not.toContain(
        "runtime-backoff.json",
      );
    }
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

function holdWith(records: Parameters<RuntimeErrorDeliveryHold["restore"]>[0]) {
  const held = new Map<string, string>();
  const cleared: string[] = [];
  const saved: Array<{ agentId: string; untilMs: number; reason: string }> = [];
  const hold = new RuntimeErrorDeliveryHold({
    deliveryQueue: {
      hold: (agentId, reason) => void held.set(agentId, reason),
      release: (agentId) => {
        held.delete(agentId);
        return [];
      },
      explicitHold: (agentId) => held.get(agentId) as never,
      pending: () => [],
    },
    flush: () => {},
    store: {
      save: (agentId, state) => void saved.push({ agentId, ...state }),
      clear: (agentId) => void cleared.push(agentId),
    },
  });
  hold.restore(records);
  return { hold, held, cleared, saved };
}

test("restoring a live wait holds the Agent's deliveries again and re-arms its release", async () => {
  jest.useFakeTimers();
  const untilMs = Date.now() + HOUR_MS;
  const { records } = await captureDaemonLogs(async () => {
    const { held, cleared } = holdWith([
      { agentId: "agent-a", untilMs, reason: "rate_limit_backoff" },
    ]);
    expect(held.get("agent-a")).toBe("rate_limit_backoff");
    expect(cleared).toEqual([]);
    jest.advanceTimersByTime(HOUR_MS + 1);
    expect(held.has("agent-a")).toBe(false);
    expect(cleared).toEqual(["agent-a"]);
  });
  // The one line that shows a wait survived the process without a live failure behind it.
  expect(
    records.find((record) => record.properties.event === "agent.runtime.backoff_restored")
      ?.properties,
  ).toEqual({
    event: "agent.runtime.backoff_restored",
    agent_id: "agent-a",
    until_ms: untilMs,
    reason: "rate_limit_backoff",
  });
});

test("restoring a wait that ended while the Daemon was down clears it without holding", () => {
  const { held, cleared } = holdWith([
    { agentId: "agent-b", untilMs: Date.now() - HOUR_MS, reason: "runtime_error_backoff" },
  ]);
  expect(held.has("agent-b")).toBe(false);
  expect(cleared).toEqual(["agent-b"]);
});

test("a window limit's backoff with no reset is recorded for the next process", () => {
  jest.useFakeTimers();
  const { hold, saved } = holdWith([]);
  // What classifyRuntimeError returns for providerLimit { kind: "window_limit" } with no
  // resetsAt: a retryable rate limit with no retryNotBefore, so the delay is exponential.
  hold.noteFailure(
    "agent-d",
    {
      errorClass: RUNTIME_ERROR_CLASS.RATE_LIMIT,
      errorReason: "quota_exhausted",
      retryDecision: "retry",
      requiredAction: "none",
      takesAgentOffline: false,
    } as never,
    "fingerprint-d",
  );
  const [record] = saved;
  expect(record?.agentId).toBe("agent-d");
  expect(record?.reason).toBe("rate_limit_backoff");
  // First exponential delay is ten seconds plus up to ten percent jitter.
  expect(record?.untilMs).toBeGreaterThanOrEqual(Date.now() + 10_000);
  expect(record?.untilMs).toBeLessThanOrEqual(Date.now() + 11_000);
});

test("a retryable failure records what it waits for, and forget clears it", () => {
  jest.useFakeTimers();
  const { hold, saved, cleared } = holdWith([]);
  hold.noteFailure(
    "agent-c",
    {
      errorClass: RUNTIME_ERROR_CLASS.RATE_LIMIT,
      errorReason: "quota_exhausted",
      retryDecision: "retry",
      retryNotBefore: new Date(Date.now() + 20 * 60_000).toISOString(),
      requiredAction: "none",
      takesAgentOffline: false,
    } as never,
    "fingerprint-c",
  );
  expect(saved).toEqual([
    { agentId: "agent-c", untilMs: expect.any(Number), reason: "rate_limit_backoff" },
  ]);
  hold.forget("agent-c");
  expect(cleared).toContain("agent-c");
});
