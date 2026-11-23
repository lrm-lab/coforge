import { expect, setSystemTime, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { RuntimeLoginRequiredError, type AgentRuntimeEvent } from "@lrm/coforge-anvil";
import type { AgentStartIntent } from "@lrm/coforge-sdk/internal";
import {
  COLD,
  FRESH_ACTIVITY,
  MEMORY,
  PROVIDER_BRIEFING,
  SWEEP_MS,
  logged,
  minutes,
  run,
  sweepAfterLaunch,
  sweepWith,
  useWakeRecycleEnvironment,
  type Harness,
  type HarnessOptions,
} from "./fixtures/wake-recycle-harness";
useWakeRecycleEnvironment();
test("the sweep stops a cold, idle, large Agent, which then wakes on its next message with a briefing", async () => {
  Bun.env[SWEEP_MS] = "5";
  const { result: h, records } = await run({}, async (h, records) => {
    await h.runtime.handleAgentStart(h.intent({ controlEpoch: 1, launchId: "launch-1" }));
    setSystemTime(minutes(90));
    await logged(records, sweepWith(1));
    expect(h.sessions[0]!.disposed).toBe(true);
    expect(h.details("idle").at(-1)).toBe(
      "Stopped idle Claude Code runtime (idle 90m, ~300k context) to free memory; it restarts on the next message",
    );
    expect(h.activities.map((a) => a.detailKind)).not.toContain("stopped");
    expect(h.statuses).not.toContain("inactive");
    await h.deliver(1);
    return h;
  });
  expect(h.sessions).toHaveLength(2);
  expect(h.rejections).toEqual([]);
  expect(h.acks).toContain("delivery-1");
  const fresh = h.sessions[1]!;
  expect(fresh.options.sessionId).toBeUndefined();
  expect(fresh.options.sessionMode).toBe("create");
  expect(h.reports.at(-1)).toMatchObject({
    sessionId: "native-2",
    replacedSessionId: "native-1",
    launchId: "launch-1",
  });
  expect(h.details("runtime_unavailable")).toEqual([FRESH_ACTIVITY]);
  const [briefing] = fresh.inputs;
  expect(briefing).toContain("<memory-index>");
  expect(briefing).toContain('<memory file="MEMORY.md"');
  expect(briefing).toContain('<active-context file="notes/active-context.md"');
  expect(briefing).toContain(PROVIDER_BRIEFING);
  expect(briefing!.indexOf("<memory-index")).toBeLessThan(briefing!.indexOf(PROVIDER_BRIEFING));
  expect(fresh.inputs.join("\n")).toContain("#general");
  const events = records.map((r) => r.properties.event);
  expect(events).toContain("agent.runtime.cold_idle_stop");
  expect(events).toContain("agent.runtime.wake_recycle");
});
test.each([
  { sessionTokens: 80_000, liveTokens: 150_000, resumes: true },
  { sessionTokens: 128_003, liveTokens: 80_000, resumes: false },
])(
  "the idle Codex stop and wake agree with $sessionTokens recorded tokens",
  async ({ sessionTokens, liveTokens, resumes }) => {
    Bun.env[SWEEP_MS] = "5";
    const facts = { ...COLD, lastContextTokens: sessionTokens };
    const { result: h } = await run({ provider: "codex", facts }, async (h, records) => {
      await h.runtime.handleAgentStart(h.intent({ controlEpoch: 1, launchId: "launch-1" }));
      h.sessions[0]!.emit({ type: "context-usage", usedTokens: liveTokens, windowTokens: 475_000 });
      setSystemTime(minutes(45));
      const warmSweep = await logged(records, sweepAfterLaunch);
      expect(warmSweep.properties).toMatchObject({ agents: 1, stops: 0, skipped_recent_event: 1 });
      expect(h.sessions[0]!.disposed).toBe(false);
      expect(h.factReads).toEqual([]);

      setSystemTime(minutes(70));
      await logged(records, sweepWith(1));
      expect(h.sessions[0]!.disposed).toBe(true);
      const stop = records.find(
        (record) => record.properties.event === "agent.runtime.cold_idle_stop",
      );
      expect(stop?.properties).toMatchObject({
        prior_context_tokens: sessionTokens,
        session_id: "native-1",
      });
      expect(stop?.properties.reason).toBe(resumes ? "idle_process" : undefined);
      await h.deliver(1);
      return h;
    });
    expect(h.sessions).toHaveLength(2);
    expect(h.sessions[1]?.options.sessionId).toBe(resumes ? "native-1" : undefined);
    expect(h.reports.at(-1)?.sessionId).toBe(resumes ? "native-1" : "native-2");
    expect(h.reports.at(-1)?.replacedSessionId).toBe(resumes ? undefined : "native-1");
    expect(h.acks).toContain("delivery-1");
  },
);

test("a session with no event for an hour is left running when its own record is recent", async () => {
  Bun.env[SWEEP_MS] = "5";
  const facts = { ...COLD, lastActivityAtMs: minutes(80).getTime() };
  await run({ facts }, async (h, records) => {
    await h.runtime.handleAgentStart(h.intent({ controlEpoch: 1, launchId: "launch-1" }));
    setSystemTime(minutes(90));
    const sweep = await logged(records, sweepAfterLaunch);
    expect(sweep.properties).toMatchObject({ agents: 1, stops: 0, skipped_recent_activity: 1 });
    expect(h.factReads).not.toEqual([]);
    expect(h.sessions[0]!.disposed).toBe(false);
  });
});
test("a session whose last event is recent is not even read by the sweep", async () => {
  Bun.env[SWEEP_MS] = "5";
  await run({}, async (h, records) => {
    await h.runtime.handleAgentStart(h.intent({ controlEpoch: 1, launchId: "launch-1" }));
    setSystemTime(minutes(59));
    const sweep = await logged(records, sweepAfterLaunch);
    expect(sweep.properties).toMatchObject({ agents: 1, stops: 0, skipped_recent_event: 1 });
    expect(h.factReads).toEqual([]);
  });
});
test("a failed recycle resumes the original session on the next qualified wake", async () => {
  const gate = Promise.withResolvers<void>();
  const { result: h } = await run(
    { failCreateAttempt: 1, createGate: gate.promise, gateCreateAttempt: 2 },
    async (h) => {
      setSystemTime(minutes(90));
      const start = h.intent({ sessionId: "old-session", sessionMode: "resume" });
      await expect(h.runtime.handleAgentStart(start)).rejects.toThrow("spawn failed");
      expect(h.attempts).toEqual([{ sessionMode: "create", sessionId: undefined }]);
      expect(h.reports).toEqual([]);
      const resumed = h.runtime.handleAgentStart(h.intent());
      await h.createEntered;
      const joining = h.runtime.handleAgentStart(h.intent());
      const delivery = h.deliver(1);
      gate.resolve();
      await Promise.all([resumed, joining, delivery]);
      return h;
    },
  );
  expect(h.attempts).toEqual([
    { sessionMode: "create", sessionId: undefined },
    { sessionMode: "resume", sessionId: "old-session" },
  ]);
  expect(h.factReads.map((read) => read.sessionId)).toEqual(["old-session"]);
  expect(h.sessions).toHaveLength(1);
  expect(h.reports).toHaveLength(1);
  expect(h.reports[0]?.sessionId).toBe("old-session");
  expect(h.reports[0]?.replacedSessionId).toBeUndefined();
  expect(h.acks).toEqual(["delivery-1"]);
  const inputs = h.sessions[0]!.inputs.join("\n");
  expect(inputs.split("#general")).toHaveLength(2);
  expect(inputs).not.toContain(PROVIDER_BRIEFING);
  expect(inputs).not.toContain("You are starting a fresh session.");
});

test("the next message wakes the old session after a failed automatic recycle", async () => {
  Bun.env[SWEEP_MS] = "5";
  await run({ failCreateAttempt: 2 }, async (h, records) => {
    await h.runtime.handleAgentStart(h.intent({ controlEpoch: 1, launchId: "launch-1" }));
    setSystemTime(minutes(90));
    await logged(records, sweepWith(1));
    await expect(h.deliver(1)).rejects.toThrow("spawn failed");
    expect(h.reports.map((report) => report.sessionId)).toEqual(["native-1"]);
    setSystemTime(minutes(91));
    await h.deliver(2);
    expect(h.attempts.slice(1)).toEqual([
      { sessionMode: "create", sessionId: undefined },
      { sessionMode: "resume", sessionId: "native-1" },
    ]);
    expect(h.acks).toEqual(["delivery-1", "delivery-2"]);
    expect(h.rejections).toEqual([]);
    expect(h.sessions[1]?.inputs.filter((input) => input.includes("#general"))).toHaveLength(1);
    expect(h.sessions[1]?.inputs.join("\n")).not.toContain(PROVIDER_BRIEFING);
    expect(h.reports.every((report) => report.replacedSessionId === undefined)).toBe(true);
  });
});

const oldSession = { sessionId: "old-session", sessionMode: "resume" } as const;
test("a work directory preparation failure leaves the next recycle eligible", async () => {
  await run({}, async (h) => {
    setSystemTime(minutes(90));
    await rm(h.agentDirectory, { recursive: true });
    await Bun.write(h.agentDirectory, "ordinary file");
    await expect(h.runtime.handleAgentStart(h.intent(oldSession))).rejects.toThrow("EEXIST");
    expect(h.attempts).toEqual([]);
    expect(h.reports).toEqual([]);
    await rm(h.agentDirectory);
    await mkdir(h.agentDirectory);
    await h.runtime.handleAgentStart(h.intent());
    expect(h.attempts).toEqual([{ sessionMode: "create", sessionId: undefined }]);
    expect(h.reports.at(-1)?.replacedSessionId).toBe("old-session");
  });
});

const retryCases: {
  name: string;
  options?: HarnessOptions;
  beforeRetry?: (h: Harness) => void | Promise<void>;
  retry?: Partial<AgentStartIntent>;
  nextFacts: string[];
}[] = [
  {
    name: "after six hours",
    beforeRetry: () => {
      setSystemTime(minutes(450));
    },
    nextFacts: ["old-session"],
  },
  {
    name: "for a different Agent with the same native ID",
    retry: { ...oldSession, agentId: "agent-b" },
    nextFacts: ["old-session"],
  },
  {
    name: "for another native ID on the same Agent",
    retry: { ...oldSession, sessionId: "another-session" },
    nextFacts: ["another-session"],
  },
  {
    name: "after a new runtime configuration is granted",
    options: { configRevisions: [1, 2] },
    nextFacts: ["old-session"],
  },
  {
    name: "after Stop",
    beforeRetry: (h) =>
      h.runtime.handleAgentStop({
        protocolMajor: 1,
        requestId: "stop-1",
        workspaceId: h.intent().workspaceId,
        computerId: h.intent().computerId,
        agentId: h.intent().agentId,
      }),
    retry: oldSession,
    nextFacts: ["old-session"],
  },
  {
    name: "for an explicit fresh start",
    retry: { sessionMode: "create" },
    nextFacts: [],
  },
  {
    name: "after a permanent login failure",
    options: { createError: new RuntimeLoginRequiredError("login required") },
    nextFacts: ["old-session"],
  },
  {
    name: "after a replacement was already reported",
    options: { reportBeforeFirstCreateError: "committed-session" },
    nextFacts: ["committed-session"],
  },
];

test.each(retryCases)(
  "uses the normal launch decision $name",
  async ({ options, beforeRetry, retry, nextFacts }) => {
    await run({ failCreateAttempt: 1, ...options }, async (h) => {
      setSystemTime(minutes(90));
      await expect(h.runtime.handleAgentStart(h.intent(oldSession))).rejects.toThrow(
        options?.createError?.message ?? "spawn failed",
      );
      if (options?.reportBeforeFirstCreateError)
        expect(h.reports[0]).toMatchObject({
          sessionId: options.reportBeforeFirstCreateError,
          replacedSessionId: "old-session",
        });
      else expect(h.reports).toEqual([]);
      await beforeRetry?.(h);
      await h.runtime.handleAgentStart(h.intent(retry));
      expect(h.attempts.map((attempt) => attempt.sessionMode)).toEqual(["create", "create"]);
      expect(h.factReads.map((read) => read.sessionId)).toEqual(["old-session", ...nextFacts]);
      expect(h.reports.at(-1)?.replacedSessionId).toBe(nextFacts[0]);
    });
  },
);
test("a recycled session can itself be recycled at the next wake", async () => {
  Bun.env[SWEEP_MS] = "5";
  const { result: h } = await run({}, async (h, records) => {
    await h.runtime.handleAgentStart(h.intent({ controlEpoch: 1, launchId: "launch-1" }));
    setSystemTime(minutes(90));
    await logged(records, sweepWith(1));
    await h.deliver(1);
    h.sessions[1]!.finish();
    setSystemTime(minutes(200));
    await h.activityWith(/idle 110m/);
    await logged(records, (r) => sweepWith(1)(r) && records.filter(sweepWith(1)).length >= 2);
    await h.deliver(2);
    return h;
  });
  expect(h.sessions.map((session) => session.options.sessionId)).toEqual([
    undefined,
    undefined,
    undefined,
  ]);
  expect(h.reports.map((report) => [report.sessionId, report.replacedSessionId])).toEqual([
    ["native-1", undefined],
    ["native-2", "native-1"],
    ["native-3", "native-2"],
  ]);
  expect(h.sessions[2]!.inputs[0]).toContain(PROVIDER_BRIEFING);
});
test.each<[string, AgentRuntimeEvent, string]>([
  ["an open tool call", { type: "tool-start", id: "tool-1", name: "bash" }, "open_tool_call"],
  [
    "a running background task",
    { type: "subagent-progress", phase: "started", taskId: "task-1" },
    "background_tasks",
  ],
])("%s keeps the sweep away", async (_name, event, blocker) => {
  Bun.env[SWEEP_MS] = "5";
  await run({}, async (h, records) => {
    await h.runtime.handleAgentStart(h.intent({ controlEpoch: 1, launchId: "launch-1" }));
    h.sessions[0]!.emit(event);
    setSystemTime(minutes(90));
    const sweep = await logged(records, sweepAfterLaunch);
    expect(sweep.properties).toMatchObject({ stops: 0 });
    expect(Object.keys(sweep.properties)).toContain(`skipped_${blocker}`);
    expect(h.sessions[0]!.disposed).toBe(false);
  });
});
test("a start that would resume a cold, large session starts a fresh one with the briefing and the starter", async () => {
  const { result: h } = await run({}, async (h) => {
    setSystemTime(minutes(90));
    await h.runtime.handleAgentStart(h.intent({ sessionId: "old-session", sessionMode: "resume" }));
    return h;
  });
  const [session] = h.sessions;
  expect(session?.options.sessionId).toBeUndefined();
  expect(session?.options.sessionMode).toBe("create");
  expect(h.reports).toHaveLength(1);
  expect(h.reports[0]).toMatchObject({ sessionId: "native-1", replacedSessionId: "old-session" });
  expect(h.details("runtime_unavailable")).toEqual([FRESH_ACTIVITY]);
  expect(session?.inputs).toHaveLength(1);
  expect(session?.inputs[0]).toContain(MEMORY.trim());
  expect(session?.inputs[0]).toContain(PROVIDER_BRIEFING);
  expect(session?.inputs[0]).toContain("You are starting a fresh session.");
  expect(session?.inputs[0]).not.toContain("You are back online");
  expect(h.factReads).toEqual([{ sessionId: "old-session" }]);
});
test.each<[string, HarnessOptions, boolean]>([
  ["carried", {}, true],
  ["had nothing to carry", { memory: false, briefing: "fails" }, false],
])(
  "a recycled start's memory decision says whether its briefing %s",
  async (_name, options, carried) => {
    const { records } = await run(options, async (h) => {
      setSystemTime(minutes(90));
      await h.runtime.handleAgentStart(
        h.intent({ sessionId: "old-session", sessionMode: "resume" }),
      );
    });
    const decisions = records.filter(
      (record) => record.properties.event === "agent.runtime.session_memory",
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.properties).toMatchObject({
      reason: "recycle",
      injected: carried,
      has_memory_block: carried,
    });
  },
);
test("the briefing is its own turn ahead of the recovery notice", async () => {
  const { result: h } = await run({}, async (h) => {
    setSystemTime(minutes(90));
    await h.runtime.handleAgentStart(
      h.intent({
        sessionId: "old-session",
        sessionMode: "resume",
        unreadSummary: { "#general": 2 },
        unreadConversationIds: { "#general": "conversation-a" },
      }),
    );
    return h;
  });
  const inputs = h.sessions[0]!.inputs;
  expect(inputs).toHaveLength(2);
  expect(inputs[0]).toContain(PROVIDER_BRIEFING);
  expect(inputs[0]).toContain("do not reply to it");
  expect(inputs[1]).toContain("#general");
});
test("a briefing that cannot be built still starts a fresh session with the memory files alone", async () => {
  const { result: h, records } = await run(
    { briefing: "fails", memory: false, activeContext: "- next: review\n" },
    async (h) => {
      setSystemTime(minutes(90));
      await h.runtime.handleAgentStart(
        h.intent({ sessionId: "old-session", sessionMode: "resume" }),
      );
      return h;
    },
  );
  expect(h.sessions[0]!.options.sessionId).toBeUndefined();
  expect(h.reports[0]).toMatchObject({ replacedSessionId: "old-session" });
  expect(h.sessions[0]!.inputs).toHaveLength(1);
  expect(h.sessions[0]!.inputs[0]).toStartWith("<memory-index>");
  expect(h.sessions[0]!.inputs[0]).toContain("- next: review");
  expect(h.sessions[0]!.inputs[0]).not.toContain('<memory file="MEMORY.md"');
  expect(h.sessions[0]!.inputs[0]).toContain("You are starting a fresh session.");
  expect(records.map((r) => r.properties.event)).toContain("agent.runtime.wake_briefing_failed");
});
test("a briefing that cannot be built, with no memory files, starts a fresh session on the plain starter", async () => {
  const { result: h, records } = await run({ briefing: "fails", memory: false }, async (h) => {
    setSystemTime(minutes(90));
    await h.runtime.handleAgentStart(h.intent({ sessionId: "old-session", sessionMode: "resume" }));
    return h;
  });
  expect(h.sessions).toHaveLength(1);
  expect(h.sessions[0]!.options.sessionId).toBeUndefined();
  expect(h.sessions[0]!.options.sessionMode).toBe("create");
  expect(h.reports[0]).toMatchObject({ replacedSessionId: "old-session" });
  expect(h.sessions[0]!.inputs).toHaveLength(1);
  expect(h.sessions[0]!.inputs[0]).toStartWith("You are starting a fresh session.");
  expect(h.sessions[0]!.inputs[0]).not.toContain("<memory-index");
  expect(h.sessions[0]!.inputs[0]).toContain("read MEMORY.md and notes/active-context.md");
  expect(records.map((r) => r.properties.event)).toContain("agent.runtime.wake_briefing_failed");
});
const RESUMED: Array<[string, HarnessOptions, Partial<AgentStartIntent>, number, number]> = [
  ["a resume prompt is carried", {}, { resumePrompt: "continue the review" }, 90, 0],
  ["the provider has no seam", { seam: false }, {}, 90, 0],
  ["the launch creates a session", {}, { sessionMode: "create" }, 90, 0],
  ["its facts cannot be read", { facts: undefined }, {}, 90, 1],
  ["it was active a minute ago", {}, {}, 1, 1],
  ["its context is small", { facts: { ...COLD, lastContextTokens: 90000 } }, {}, 90, 1],
  ["the Agent turned recycling off", { launchEnvVars: { COFORGE_WAKE_RECYCLE: "0" } }, {}, 90, 0],
];
test.each(RESUMED)(
  "resumes the prior session when %s",
  async (_name, options, intent, idleMinutes, reads) => {
    const { result: h } = await run(options, async (h) => {
      setSystemTime(minutes(idleMinutes));
      await h.runtime.handleAgentStart(
        h.intent({ sessionId: "old-session", sessionMode: "resume", ...intent }),
      );
      return h;
    });
    expect(h.sessions[0]!.options.sessionId).toBe("old-session");
    expect(h.reports[0]?.replacedSessionId).toBeUndefined();
    expect(h.details("runtime_unavailable")).toEqual([]);
    expect(h.factReads).toHaveLength(reads);
    expect(h.sessions[0]!.inputs.join("\n")).not.toContain("<memory-index");
  },
);
test("an Agent's own variables override the daemon's environment, and reach the provider", async () => {
  Bun.env.COFORGE_WAKE_RECYCLE = "0";
  const env = { COFORGE_WAKE_RECYCLE: "1", CLAUDE_CONFIG_DIR: "/x" };
  const { result: h } = await run({ launchEnvVars: env }, async (h) => {
    setSystemTime(minutes(90));
    await h.runtime.handleAgentStart(h.intent({ sessionId: "old-session", sessionMode: "resume" }));
    return h;
  });
  expect(h.sessions[0]!.options.sessionId).toBeUndefined();
  expect(h.factReads[0]?.envVars).toEqual(env);
});
test("the daemon's environment turns recycling off", async () => {
  Bun.env.COFORGE_WAKE_RECYCLE = "off";
  const { result: h } = await run({}, async (h) => {
    setSystemTime(minutes(90));
    await h.runtime.handleAgentStart(h.intent({ sessionId: "old-session", sessionMode: "resume" }));
    return h;
  });
  expect(h.sessions[0]!.options.sessionId).toBe("old-session");
  expect(h.factReads).toEqual([]);
});
