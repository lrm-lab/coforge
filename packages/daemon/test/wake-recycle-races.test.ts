import { expect, setSystemTime, test } from "bun:test";
import {
  SWEEP_MS,
  logged,
  minutes,
  run,
  sweepWith,
  until,
  useWakeRecycleEnvironment,
  type Harness,
  type HarnessOptions,
} from "./fixtures/wake-recycle-harness";

useWakeRecycleEnvironment();

const START_INTENT = { controlEpoch: 1, launchId: "launch-1" };
const APP_ITEM = {
  appId: "system.reminder",
  notificationClass: "due",
  sourceRef: { kind: "reminder", id: "123e4567-e89b-42d3-a456-426614174000", revision: "1" },
  title: "Due",
  summary: "Now",
} as const;

/** Starts the Agent, makes it cold, and waits until the sweep has begun ending its runtime. */
async function endingRuntime(h: Harness) {
  await h.runtime.handleAgentStart(h.intent(START_INTENT));
  setSystemTime(minutes(90));
  await h.activityWith(/^Stopped idle Claude Code runtime/);
}

test("a message that arrives while the runtime is ending is kept, and wakes the Agent with a briefing that does not claim there is none", async () => {
  Bun.env[SWEEP_MS] = "5";
  const gate = Promise.withResolvers<void>();
  const { result: h } = await run({ disposeGate: gate.promise }, async (h, records) => {
    await endingRuntime(h);
    await h.deliver(1);
    // Taken into custody, not handed to the dying process and not rejected.
    expect(h.acks).toEqual(["delivery-1"]);
    expect(h.sessions[0]!.inputs.join("\n")).not.toContain("#general");
    gate.resolve();
    await logged(records, sweepWith(1));
    await until(() => h.sessions[1]?.inputs.join("\n").includes("#general") === true);
    return h;
  });
  expect(h.rejections).toEqual([]);
  const inputs = h.sessions[1]!.inputs;
  // The briefing, then the message: the starter's "no new messages" would contradict the notice.
  expect(inputs[0]).toContain("<memory-index");
  expect(inputs[0]).not.toContain("No new messages are pending");
  expect(inputs.join("\n")).toContain("#general");
});

test("the starter that follows a briefing does not send the Agent back to a MEMORY.md it was given whole", async () => {
  const { result: h } = await run({}, async (h) => {
    setSystemTime(minutes(90));
    await h.runtime.handleAgentStart(h.intent({ sessionId: "old-session", sessionMode: "resume" }));
    return h;
  });
  const [turn] = h.sessions[0]!.inputs;
  expect(turn).toContain("You are starting a fresh session.");
  expect(turn).toContain("read notes/active-context.md");
  expect(turn).not.toContain("read MEMORY.md and");
});

test("a MEMORY.md that was cut still sends the Agent to read the file", async () => {
  const { result: h } = await run({ memory: "long" }, async (h) => {
    setSystemTime(minutes(90));
    await h.runtime.handleAgentStart(h.intent({ sessionId: "old-session", sessionMode: "resume" }));
    return h;
  });
  expect(h.sessions[0]!.inputs[0]).toContain("read MEMORY.md and notes/active-context.md");
});

test("a Stop that finishes while the runtime is ending is not followed by a relaunch", async () => {
  Bun.env[SWEEP_MS] = "5";
  const gate = Promise.withResolvers<void>();
  const { result: h } = await run({ disposeGate: gate.promise }, async (h, records) => {
    await endingRuntime(h);
    await h.deliver(1);
    const stopped = h.runtime.stopAgent("agent-a");
    gate.resolve();
    await stopped;
    await logged(records, sweepWith(1));
    return h;
  });
  expect(h.sessions).toHaveLength(1);
});

test("an app-item notice that arrives while the runtime is ending waits for the relaunch", async () => {
  Bun.env[SWEEP_MS] = "5";
  const gate = Promise.withResolvers<void>();
  const { result: h } = await run({ disposeGate: gate.promise }, async (h, records) => {
    await endingRuntime(h);
    await h.runtime.mintAppItem("agent-a", APP_ITEM);
    expect(h.sessions[0]!.inputs.join("\n")).not.toContain("New app item available");
    gate.resolve();
    await logged(records, sweepWith(1));
    await until(() => h.sessions[1]?.inputs.join("\n").includes("New app item") === true);
    return h;
  });
  expect(h.sessions).toHaveLength(2);
  expect(h.sessions[1]!.inputs.join("\n")).toContain("New app item available");
});

test("when the runtime will not exit, what was kept meanwhile reaches the process that stayed", async () => {
  Bun.env[SWEEP_MS] = "5";
  const gate = Promise.withResolvers<void>();
  const options: HarnessOptions = { disposeGate: gate.promise, disposeFails: true };
  const { result: h } = await run(options, async (h, records) => {
    await endingRuntime(h);
    await h.deliver(1);
    gate.resolve();
    await h.activityWith(/^Stopping the idle Claude Code runtime failed/);
    await logged(records, sweepWith(1));
    await until(() => h.sessions[0]!.inputs.join("\n").includes("#general"));
    // Checked before the harness's own shutdown ends the process.
    expect(h.sessions[0]!.disposed).toBe(false);
    return h;
  });
  expect(h.sessions).toHaveLength(1);
  expect(h.rejections).toEqual([]);
});

test("when the runtime will not exit, an app-item notice kept meanwhile reaches the process that stayed", async () => {
  Bun.env[SWEEP_MS] = "5";
  const gate = Promise.withResolvers<void>();
  const options: HarnessOptions = { disposeGate: gate.promise, disposeFails: true };
  const { result: h } = await run(options, async (h, records) => {
    await endingRuntime(h);
    await h.runtime.mintAppItem("agent-a", APP_ITEM);
    gate.resolve();
    await h.activityWith(/^Stopping the idle Claude Code runtime failed/);
    await logged(records, sweepWith(1));
    await until(() => h.sessions[0]!.inputs.join("\n").includes("New app item available"));
    return h;
  });
  expect(h.sessions).toHaveLength(1);
});
