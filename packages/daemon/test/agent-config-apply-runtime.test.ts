import { expect, test } from "bun:test";
import type { LogRecord } from "@logtape/logtape";
import type { AgentConfigSync } from "@lrm/coforge-sdk/internal";
import {
  connection,
  run,
  until,
  useWakeRecycleEnvironment,
  type Harness,
} from "./fixtures/wake-recycle-harness";

useWakeRecycleEnvironment();

const AGENT = "agent-a";

function push(revision: number, overrides: Partial<AgentConfigSync> = {}): AgentConfigSync {
  return {
    protocolMajor: 1,
    workspaceId: connection.workspaceId,
    computerId: connection.computerId,
    agentId: AGENT,
    provider: "claude-code",
    model: `model-${revision}`,
    modelProvider: "anthropic",
    reasoning: "balanced",
    revision,
    ...overrides,
  };
}

const outcomes = (records: readonly LogRecord[]) =>
  records
    .filter((record) => record.properties.event === "agent.runtime.config_push")
    .map((record) => record.properties.outcome);

/** A launched Agent mid-turn: a delivery started a turn that only `finish()` ends. */
async function busyAgent(h: Harness) {
  await h.runtime.handleAgentStart(h.intent({ controlEpoch: 1, launchId: "launch-1" }));
  await h.deliver(1);
  expect(h.sessions[0]!.disposed).toBe(false);
}

test("a busy Agent keeps its turn until it ends, then stops and wakes on the new model in the same session", async () => {
  const { result: h, records } = await run({}, async (h) => {
    await busyAgent(h);
    await h.runtime.handleAgentConfig(push(2, { model: "opus" }));
    // The turn is not cut: nothing is stopped, though a wake would already use the new model.
    expect(h.sessions[0]!.disposed).toBe(false);
    expect(h.runtime.restartConfig(AGENT)?.config.model).toBe("opus");

    h.sessions[0]!.finish();
    await until(() => h.sessions[0]!.disposed);
    // The Agent stays active: no stopped report and no inactive status.
    expect(h.details("stopped")).toEqual([]);
    expect(h.statuses).not.toContain("inactive");
    expect(h.details("idle").at(-1)).toContain("to apply its new configuration");

    await h.deliver(2);
    return h;
  });
  expect(h.sessions).toHaveLength(2);
  expect(h.rejections).toEqual([]);
  expect(h.sessions[1]!.options.runtime?.model).toBe("opus");
  // The wake resumes the session the first launch reported.
  expect(h.sessions[1]!.options.sessionId).toBe("native-1");
  expect(h.sessions[1]!.options.sessionMode).toBe("resume");
  expect(outcomes(records)).toEqual(["pending", "idle_stop"]);
});

test("the notice that turn left unconsumed goes with the launch the apply wakes, not the old turn", async () => {
  let notice: string | undefined;
  const { result: h } = await run({}, async (h) => {
    await busyAgent(h);
    notice = h.sessions[0]!.inputs.at(-1);
    await h.runtime.handleAgentConfig(push(2, { model: "opus" }));
    h.sessions[0]!.finish();
    await until(() => h.sessions[0]!.disposed);
    await h.deliver(2);
    await until(() => h.sessions[1]!.inputs.length > 0);
    return h;
  });
  expect(h.sessions).toHaveLength(2);
  // The stop the push waits for wins: the words are written once, into the launch that follows,
  // never again into the turn that ended.
  expect(h.sessions[0]!.inputs.filter((text) => text === notice)).toHaveLength(1);
  expect(h.sessions[1]!.inputs).toContain(notice!);
});

test("an idle Agent is stopped at once and its next message wakes it", async () => {
  const { result: h } = await run({}, async (h) => {
    await h.runtime.handleAgentStart(h.intent({ controlEpoch: 1, launchId: "launch-1" }));
    await h.runtime.handleAgentConfig(push(2, { model: "opus" }));
    await until(() => h.sessions[0]!.disposed);
    expect(h.sessions).toHaveLength(1);
    await h.deliver(1);
    return h;
  });
  expect(h.sessions).toHaveLength(2);
  expect(h.sessions[1]!.options.runtime?.model).toBe("opus");
  expect(h.sessions[1]!.options.sessionId).toBe("native-1");
});

test("a stopped runtime's restart config is updated and no process is touched", async () => {
  const { result: h, records } = await run({}, async (h) => {
    await h.runtime.handleAgentStart(h.intent({ controlEpoch: 1, launchId: "launch-1" }));
    await h.runtime.handleAgentConfig(push(2, { model: "opus" }));
    await until(() => h.sessions[0]!.disposed);

    await h.runtime.handleAgentConfig(push(3, { model: "sonnet", reasoning: "high" }));
    expect(h.runtime.restartConfig(AGENT)?.config).toMatchObject({
      model: "sonnet",
      reasoning: "high",
    });
    return h;
  });
  expect(h.sessions).toHaveLength(1);
  expect(outcomes(records)).toEqual(["pending", "idle_stop", "applied"]);
});

test("a push for another provider is dropped and the Agent keeps running", async () => {
  const { result: h, records } = await run({}, async (h) => {
    await h.runtime.handleAgentStart(h.intent({ controlEpoch: 1, launchId: "launch-1" }));
    await h.runtime.handleAgentConfig(push(2, { provider: "codex", model: "gpt" }));
    expect(h.sessions[0]!.disposed).toBe(false);
    expect(h.runtime.restartConfig(AGENT)?.config.provider).toBe("claude-code");
    return h;
  });
  expect(h.sessions).toHaveLength(1);
  expect(outcomes(records)).toEqual(["provider_mismatch"]);
});

test("a Stop cancels the pending apply", async () => {
  const { records } = await run({}, async (h) => {
    await busyAgent(h);
    await h.runtime.handleAgentConfig(push(2, { model: "opus" }));
    await h.runtime.stopAgent(AGENT);
    expect(h.runtime.restartConfig(AGENT)).toBeUndefined();
  });
  expect(outcomes(records)).toEqual(["pending", "cancelled"]);
});

test("a Start that launches with a revision makes a push not newer than it stale", async () => {
  const { records } = await run({}, async (h) => {
    await h.runtime.handleAgentStart(
      h.intent({ controlEpoch: 1, launchId: "launch-1", agentConfigRevision: 5 }),
    );
    await h.runtime.handleAgentConfig(push(5, { model: "same-revision" }));
    await h.runtime.handleAgentConfig(push(4, { model: "older" }));
    expect(h.sessions[0]!.disposed).toBe(false);
    expect(h.runtime.restartConfig(AGENT)?.config.model).toBe("default");
  });
  expect(outcomes(records)).toEqual(["stale", "stale"]);
});

test("the ready request reports the revision held for each running Agent, and none for a revision never held", async () => {
  await run({}, async (h) => {
    await busyAgent(h);
    // A Start with no revision (an older server) holds nothing, so nothing is reported.
    expect(h.readyRequest()).toMatchObject({ runningAgentIds: [AGENT] });
    expect(h.readyRequest()).not.toHaveProperty("appliedAgentConfigs");

    // Pending behind the running turn, the revision is held and reported.
    await h.runtime.handleAgentConfig(push(4, { model: "opus" }));
    expect(h.readyRequest().appliedAgentConfigs).toEqual([{ agentId: AGENT, revision: 4 }]);
  });
});

test("a revision held for an Agent that is not running is not reported", async () => {
  await run({}, async (h) => {
    await h.runtime.handleAgentConfig(push(2));
    expect(h.readyRequest().runningAgentIds).toEqual([]);
    expect(h.readyRequest()).not.toHaveProperty("appliedAgentConfigs");
  });
});

test("a Start that only joins a launch in flight neither cancels the pending apply nor raises the held revision", async () => {
  const gate = Promise.withResolvers<void>();
  const { records } = await run({ createGate: gate.promise }, async (h) => {
    const first = h.runtime.handleAgentStart(h.intent({ agentConfigRevision: 2 }));
    await h.createEntered;
    await h.runtime.handleAgentConfig(push(3));
    const joined = h.runtime.handleAgentStart(
      h.intent({ agentConfigRevision: 9, resumePrompt: "continue" }),
    );
    gate.resolve();
    await Promise.all([first, joined]);
    expect(h.readyRequest().appliedAgentConfigs).toEqual([{ agentId: AGENT, revision: 3 }]);
  });
  expect(outcomes(records)).toEqual(["pending"]);
});
