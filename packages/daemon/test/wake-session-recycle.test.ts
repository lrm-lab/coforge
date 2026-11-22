import { expect, test } from "bun:test";
import {
  composeWakeSections,
  decideWakeRecycle,
  describeRecycledSession,
  resolveWakeRecycleConfig,
  resolveWakeRecycleSweepMs,
  selectColdIdleStops,
  type ColdIdleSweepView,
  type WakeRecycleInput,
  type WakeResumeReason,
} from "#src/agent-runtime/wake-session-recycle";

const MINUTE = 60_000;
const NOW = Date.parse("2026-10-23T12:00:00.000Z");
const config = resolveWakeRecycleConfig({}, {});

const wake = (overrides: Partial<WakeRecycleInput> = {}): WakeRecycleInput => ({
  config,
  supported: true,
  sessionId: "session-1",
  hasResumePrompt: false,
  facts: { lastActivityAtMs: NOW - 90 * MINUTE, lastContextTokens: 200_000 },
  nowMs: NOW,
  ...overrides,
});

test("the defaults are the reference client's thresholds, on", () => {
  expect(config).toEqual({
    enabled: true,
    minContextTokens: 128_000,
    minColdGapMs: 60 * MINUTE,
    minColdGap5mTierMs: 12 * MINUTE,
    minContextTokensPastTier: 64_000,
    panelTokens: 8_000,
  });
  expect(resolveWakeRecycleSweepMs({})).toBe(10 * MINUTE);
});

test.each(["0", "false", "off", " OFF "])(
  "COFORGE_WAKE_RECYCLE=%p disables the recycle",
  (value) => {
    expect(resolveWakeRecycleConfig({}, { COFORGE_WAKE_RECYCLE: value }).enabled).toBe(false);
  },
);

test("an Agent's variables override the process environment, and bad values fall back", () => {
  const processEnv = {
    COFORGE_WAKE_RECYCLE: "0",
    COFORGE_WAKE_RECYCLE_MIN_CONTEXT_TOKENS: "50000",
    COFORGE_WAKE_RECYCLE_MIN_COLD_GAP_MS: "-5",
    COFORGE_WAKE_RECYCLE_PANEL_TOKENS: "1000",
  };
  expect(resolveWakeRecycleConfig({}, processEnv)).toEqual({
    enabled: false,
    minContextTokens: 50_000,
    minColdGapMs: 60 * MINUTE,
    minColdGap5mTierMs: 12 * MINUTE,
    minContextTokensPastTier: 64_000,
    panelTokens: 1_000,
  });
  expect(
    resolveWakeRecycleConfig(
      { COFORGE_WAKE_RECYCLE: "1", COFORGE_WAKE_RECYCLE_MIN_CONTEXT_TOKENS: "70000" },
      processEnv,
    ),
  ).toMatchObject({ enabled: true, minContextTokens: 70_000 });
  // An empty value is unset: it does not mask the daemon's own setting.
  expect(
    resolveWakeRecycleConfig(
      { COFORGE_WAKE_RECYCLE: "", COFORGE_WAKE_RECYCLE_MIN_CONTEXT_TOKENS: " " },
      processEnv,
    ),
  ).toMatchObject({ enabled: false, minContextTokens: 50_000 });
});

test("the sweep period comes from the process environment", () => {
  expect(resolveWakeRecycleSweepMs({ COFORGE_WAKE_RECYCLE_SWEEP_MS: "250" })).toBe(250);
  expect(resolveWakeRecycleSweepMs({ COFORGE_WAKE_RECYCLE_SWEEP_MS: "0" })).toBe(10 * MINUTE);
});

test("a cold, large session is recycled, naming what it retires", () => {
  expect(decideWakeRecycle(wake())).toEqual({
    action: "recycle",
    priorSessionId: "session-1",
    idleMs: 90 * MINUTE,
    priorContextTokens: 200_000,
  });
  expect(describeRecycledSession(73 * MINUTE, 412_345)).toBe("idle 73m, ~412k context");
});

test.each<[string, Partial<WakeRecycleInput>, WakeResumeReason]>([
  ["recycling is off", { config: { ...config, enabled: false } }, "disabled"],
  ["the provider has no seam", { supported: false }, "unsupported"],
  ["there is no prior session", { sessionId: undefined }, "no_prior_session"],
  ["the launch carries a resume prompt", { hasResumePrompt: true }, "explicit_resume_prompt"],
  ["the session cannot be read", { facts: undefined }, "session_facts_unavailable"],
  [
    "the last activity is unknown",
    { facts: { lastContextTokens: 200_000 } },
    "session_facts_unavailable",
  ],
  [
    "the context is unknown",
    { facts: { lastActivityAtMs: NOW - 90 * MINUTE } },
    "session_facts_unavailable",
  ],
  [
    "the cache may still be warm",
    { facts: { lastActivityAtMs: NOW - 60 * MINUTE, lastContextTokens: 200_000 } },
    "cache_possibly_warm",
  ],
  [
    "the activity is in the future",
    { facts: { lastActivityAtMs: NOW + MINUTE, lastContextTokens: 200_000 } },
    "cache_possibly_warm",
  ],
  [
    "the context is small",
    { facts: { lastActivityAtMs: NOW - 90 * MINUTE, lastContextTokens: 128_000 } },
    "context_below_threshold",
  ],
])("resumes when %s", (_name, overrides, reason) => {
  expect(decideWakeRecycle(wake(overrides))).toEqual({ action: "resume", reason });
});

test("a provider's cold gap is the default, and the environment still overrides it", () => {
  expect(resolveWakeRecycleConfig({}, {}, 30 * MINUTE).minColdGapMs).toBe(30 * MINUTE);
  expect(resolveWakeRecycleConfig({}, {}, 0).minColdGapMs).toBe(60 * MINUTE);
  expect(
    resolveWakeRecycleConfig(
      { COFORGE_WAKE_RECYCLE_MIN_COLD_GAP_MS: String(45 * MINUTE) },
      {},
      30 * MINUTE,
    ).minColdGapMs,
  ).toBe(45 * MINUTE);
});

test("the cold gap and context threshold come from the config", () => {
  const tuned = resolveWakeRecycleConfig({
    COFORGE_WAKE_RECYCLE_MIN_COLD_GAP_MS: String(5 * MINUTE),
    COFORGE_WAKE_RECYCLE_MIN_CONTEXT_TOKENS: "1000",
  });
  const facts = { lastActivityAtMs: NOW - 6 * MINUTE, lastContextTokens: 1_001 };
  expect(decideWakeRecycle(wake({ config: tuned, facts })).action).toBe("recycle");
});

test("wake sections are joined by a blank line, skipping empty ones", () => {
  expect(composeWakeSections("a", undefined, "", "b")).toBe("a\n\nb");
  expect(composeWakeSections(undefined, "")).toBe("");
});

function view(overrides: Partial<ColdIdleSweepView> = {}): ColdIdleSweepView {
  return {
    agentId: "agent-a",
    provider: "claude-code",
    busyReason: undefined,
    supported: true,
    sessionId: "session-1",
    lastEventAtMs: NOW - 80 * MINUTE,
    ...overrides,
  };
}

async function select(views: ColdIdleSweepView[], facts = {}, processEnv = {}) {
  const skipped: Array<[string, string]> = [];
  const reads: string[] = [];
  const stops = await selectColdIdleStops(views, {
    nowMs: NOW,
    processEnv,
    async readFacts(_view, sessionId) {
      reads.push(sessionId);
      return { lastActivityAtMs: NOW - 70 * MINUTE, lastContextTokens: 300_000, ...facts };
    },
    onSkip: (agentId, reason) => skipped.push([agentId, reason]),
  });
  return { stops, skipped, reads };
}

test("a provider-declared 30 minute gap stops a session the 60 minute default keeps", async () => {
  const codex = view({
    provider: "codex",
    providerMinColdGapMs: 30 * MINUTE,
    lastEventAtMs: NOW - 31 * MINUTE,
  });
  const facts = { lastActivityAtMs: NOW - 31 * MINUTE, lastContextTokens: 200_000 };
  const stopped = await select([codex], facts);
  expect(stopped.stops.map((stop) => stop.idleMs)).toEqual([31 * MINUTE]);
  const overridden = await select([codex], facts, {
    COFORGE_WAKE_RECYCLE_MIN_COLD_GAP_MS: String(60 * MINUTE),
  });
  expect(overridden.stops).toEqual([]);
  expect(overridden.skipped).toEqual([["agent-a", "recent_event"]]);
  const claude = await select([
    view({ provider: "claude-code", lastEventAtMs: NOW - 31 * MINUTE }),
  ]);
  expect(claude.stops).toEqual([]);
  expect(claude.skipped).toEqual([["agent-a", "recent_event"]]);
});

test("a cold idle Agent with a large context is selected, idle since its latest activity", async () => {
  const { stops, skipped } = await select([view()]);
  expect(skipped).toEqual([]);
  expect(stops).toEqual([
    {
      agentId: "agent-a",
      sessionId: "session-1",
      idleMs: 70 * MINUTE,
      priorContextTokens: 300_000,
    },
  ]);
  // The runtime's own last event wins when it is later than the session's record.
  const later = await select([view({ lastEventAtMs: NOW - 65 * MINUTE })], {
    lastActivityAtMs: NOW - 90 * MINUTE,
  });
  expect(later.stops[0]?.idleMs).toBe(65 * MINUTE);
});

test.each<[string, Partial<ColdIdleSweepView>, string, boolean]>([
  ["busy", { busyReason: "open_tool_call" }, "open_tool_call", false],
  ["unsupported", { supported: false }, "unsupported", false],
  ["no session", { sessionId: undefined }, "no_session", false],
  ["no event time", { lastEventAtMs: undefined }, "no_session", false],
  ["a recent event", { lastEventAtMs: NOW - 59 * MINUTE }, "recent_event", false],
  ["disabled by the Agent", { envVars: { COFORGE_WAKE_RECYCLE: "off" } }, "disabled", false],
])("skips an Agent that is %s, before reading its session", async (_name, overrides, reason) => {
  const { stops, skipped, reads } = await select([view(overrides)]);
  expect(stops).toEqual([]);
  expect(skipped).toEqual([["agent-a", reason]]);
  expect(reads).toEqual([]);
});

test.each<[string, Parameters<typeof select>[1], string]>([
  ["session record recent", { lastActivityAtMs: NOW - 10 * MINUTE }, "recent_activity"],
  ["context small", { lastContextTokens: 100_000 }, "context_below_threshold"],
  ["activity unknown", { lastActivityAtMs: undefined }, "session_facts_unavailable"],
  ["context unknown", { lastContextTokens: undefined }, "session_facts_unavailable"],
])("skips an Agent whose %s", async (_name, facts, reason) => {
  const { stops, skipped } = await select([view()], facts);
  expect(stops).toEqual([]);
  expect(skipped).toEqual([["agent-a", reason]]);
});

test("an unreadable session is a skip, and each Agent uses its own thresholds", async () => {
  const skipped: string[] = [];
  const stops = await selectColdIdleStops(
    [
      view({ agentId: "unreadable", sessionId: "gone" }),
      view({ agentId: "low-bar", envVars: { COFORGE_WAKE_RECYCLE_MIN_CONTEXT_TOKENS: "10" } }),
      view({ agentId: "default-bar" }),
    ],
    {
      nowMs: NOW,
      processEnv: {},
      readFacts: async (_view, sessionId) => {
        if (sessionId === "gone") throw new Error("unreadable");
        return { lastActivityAtMs: NOW - 70 * MINUTE, lastContextTokens: 100 };
      },
      onSkip: (agentId, reason) => skipped.push(`${agentId}:${reason}`),
    },
  );
  expect(stops.map((stop) => stop.agentId)).toEqual(["low-bar"]);
  expect(skipped).toEqual([
    "unreadable:session_facts_unavailable",
    "default-bar:context_below_threshold",
  ]);
});

test("prompt-cache tier gating recycles 5m-tier sessions after 12m and lowers the context bar past 60m", () => {
  expect(
    decideWakeRecycle(
      wake({
        facts: { lastActivityAtMs: NOW - 15 * MINUTE, lastContextTokens: 150_000, cacheTier: "5m" },
      }),
    ),
  ).toEqual({
    action: "recycle",
    priorSessionId: "session-1",
    idleMs: 15 * MINUTE,
    priorContextTokens: 150_000,
  });
  expect(
    decideWakeRecycle(
      wake({
        facts: { lastActivityAtMs: NOW - 12 * MINUTE, lastContextTokens: 150_000, cacheTier: "5m" },
      }),
    ),
  ).toEqual({ action: "resume", reason: "cache_possibly_warm" });
  expect(
    decideWakeRecycle(
      wake({
        facts: { lastActivityAtMs: NOW - 30 * MINUTE, lastContextTokens: 200_000, cacheTier: "1h" },
      }),
    ),
  ).toEqual({ action: "resume", reason: "cache_possibly_warm" });
  expect(
    decideWakeRecycle(
      wake({
        facts: { lastActivityAtMs: NOW - 70 * MINUTE, lastContextTokens: 70_000, cacheTier: "1h" },
      }),
    ),
  ).toEqual({
    action: "recycle",
    priorSessionId: "session-1",
    idleMs: 70 * MINUTE,
    priorContextTokens: 70_000,
  });
  expect(
    decideWakeRecycle(
      wake({
        facts: { lastActivityAtMs: NOW - 70 * MINUTE, lastContextTokens: 64_000, cacheTier: "5m" },
      }),
    ),
  ).toEqual({ action: "resume", reason: "context_below_threshold" });
  const custom = resolveWakeRecycleConfig({
    COFORGE_WAKE_RECYCLE_MIN_COLD_GAP_5M_TIER_MS: String(5 * MINUTE),
    COFORGE_WAKE_RECYCLE_MIN_CONTEXT_TOKENS_PAST_TIER: "40000",
  });
  expect(
    decideWakeRecycle(
      wake({
        config: custom,
        facts: { lastActivityAtMs: NOW - 6 * MINUTE, lastContextTokens: 150_000, cacheTier: "5m" },
      }),
    ).action,
  ).toBe("recycle");
  expect(
    decideWakeRecycle(
      wake({
        config: custom,
        facts: { lastActivityAtMs: NOW - 70 * MINUTE, lastContextTokens: 50_000, cacheTier: "1h" },
      }),
    ).action,
  ).toBe("recycle");
});

test("cold idle sweep uses the 5m cache-tier cold gap when a live session reports 5m tier", async () => {
  const fiveMin = view({
    provider: "claude-code",
    lastEventAtMs: NOW - 15 * MINUTE,
    lastCacheTier: "5m",
  });
  const result = await select([fiveMin], {
    lastActivityAtMs: NOW - 15 * MINUTE,
    lastContextTokens: 150_000,
    cacheTier: "5m",
  });
  expect(result.stops.map((stop) => stop.idleMs)).toEqual([15 * MINUTE]);
});
