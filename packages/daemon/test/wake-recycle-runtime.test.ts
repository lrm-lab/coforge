import { expect, setSystemTime, test } from "bun:test";
import type { AgentRuntimeEvent } from "#src/code-agent/contract";
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
  sweepWith,
  useWakeRecycleEnvironment,
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
    // The Agent stays active: no stopped, crashed or inactive report.
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
  // A fresh session, reported as replacing the stopped one under the same launch identity.
  expect(fresh.options.sessionId).toBeUndefined();
  expect(fresh.options.sessionMode).toBe("create");
  expect(h.reports.at(-1)).toMatchObject({
    sessionId: "native-2",
    replacedSessionId: "native-1",
    launchId: "launch-1",
  });
  expect(h.details("runtime_unavailable")).toEqual([FRESH_ACTIVITY]);
  // The briefing is the first input, then the message.
  const [briefing] = fresh.inputs;
  expect(briefing).toContain('<memory-index file="MEMORY.md"');
  expect(briefing).toContain(PROVIDER_BRIEFING);
  expect(briefing!.indexOf("<memory-index")).toBeLessThan(briefing!.indexOf(PROVIDER_BRIEFING));
  expect(fresh.inputs.join("\n")).toContain("#general");
  const events = records.map((r) => r.properties.event);
  expect(events).toContain("agent.runtime.cold_idle_stop");
  expect(events).toContain("agent.runtime.wake_recycle");
});

test("a session with no event for an hour is left running when its own record is recent", async () => {
  Bun.env[SWEEP_MS] = "5";
  const facts = { ...COLD, lastActivityAtMs: minutes(80).getTime() };
  await run({ facts }, async (h, records) => {
    await h.runtime.handleAgentStart(h.intent({ controlEpoch: 1, launchId: "launch-1" }));
    setSystemTime(minutes(90));
    const sweep = await logged(
      records,
      (r) => r.properties.event === "agent.runtime.cold_idle_sweep",
    );
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
    const sweep = await logged(
      records,
      (r) => r.properties.event === "agent.runtime.cold_idle_sweep",
    );
    expect(sweep.properties).toMatchObject({ agents: 1, stops: 0, skipped_recent_event: 1 });
    expect(h.factReads).toEqual([]);
  });
});

test("a launch that fails after the decision keeps the old session id for the next attempt", async () => {
  const { result: h } = await run({ failFirstCreate: true }, async (h) => {
    setSystemTime(minutes(90));
    const start = h.intent({ sessionId: "old-session", sessionMode: "resume" });
    await expect(h.runtime.handleAgentStart(start)).rejects.toThrow("spawn failed");
    expect(h.reports).toEqual([]);
    // The next attempt is not told a session id: the daemon still remembers the old one.
    await h.runtime.handleAgentStart(h.intent({ requestId: "start-1" }));
    return h;
  });
  expect(h.factReads.map((read) => read.sessionId)).toEqual(["old-session", "old-session"]);
  expect(h.sessions).toHaveLength(1);
  expect(h.reports.at(-1)).toMatchObject({
    sessionId: "native-1",
    replacedSessionId: "old-session",
  });
});

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
    const sweep = await logged(
      records,
      (r) => r.properties.event === "agent.runtime.cold_idle_sweep",
    );
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
  // One first turn: the briefing, ending with the fresh-session starter (skipped once it is live).
  expect(session?.inputs).toHaveLength(1);
  expect(session?.inputs[0]).toContain(MEMORY.trim());
  expect(session?.inputs[0]).toContain(PROVIDER_BRIEFING);
  expect(session?.inputs[0]).toContain("You are starting a fresh session.");
  expect(session?.inputs[0]).not.toContain("You are back online");
  expect(h.factReads).toEqual([{ sessionId: "old-session" }]);
});

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

test("a briefing that cannot be built still starts a fresh, bare session", async () => {
  const { result: h, records } = await run({ briefing: "fails", memory: false }, async (h) => {
    setSystemTime(minutes(90));
    await h.runtime.handleAgentStart(h.intent({ sessionId: "old-session", sessionMode: "resume" }));
    return h;
  });
  expect(h.sessions[0]!.options.sessionId).toBeUndefined();
  expect(h.reports[0]).toMatchObject({ replacedSessionId: "old-session" });
  expect(h.sessions[0]!.inputs).toHaveLength(1);
  expect(h.sessions[0]!.inputs[0]).toStartWith("You are starting a fresh session.");
  expect(records.map((r) => r.properties.event)).toContain("agent.runtime.wake_briefing_failed");
});

const RESUMED: Array<[string, HarnessOptions, Partial<AgentStartIntent>, number, number]> = [
  ["a resume prompt is carried", {}, { resumePrompt: "continue the review" }, 90, 0],
  ["the provider has no seam", { seam: false }, {}, 90, 0],
  ["the launch creates a session", {}, { sessionMode: "create" }, 90, 0],
  ["its facts cannot be read", { facts: undefined }, {}, 90, 1],
  ["it was active a minute ago", {}, {}, 1, 1],
  ["its context is small", { facts: { ...COLD, lastContextTokens: 90_000 } }, {}, 90, 1],
  ["it is a Memory Agent", {}, { memoryAgent: true }, 90, 0],
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
