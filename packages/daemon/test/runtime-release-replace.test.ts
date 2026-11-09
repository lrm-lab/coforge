import { expect, test } from "bun:test";
import type { AgentSession } from "@lrm/coforge-anvil";
import type { AgentRestartConfig } from "#src/agent-runtime/agent-process-manager";
import {
  RuntimeRelease,
  type ReleasableLaunch,
  type RuntimeReleasePorts,
} from "#src/daemon-runtime/runtime-release";
import { ProviderProgress } from "#src/daemon-runtime/stalled-recovery";
import { replayRejectedEndPlan } from "#src/daemon-runtime/runtime-release-plans";

type Launch = {
  stopping: boolean;
  progress?: ProviderProgress;
  backgroundTasks?: ReleasableLaunch["backgroundTasks"];
};

const restart: AgentRestartConfig = {
  config: { provider: "pi", model: "m", modelProvider: "anthropic", reasoning: "balanced" },
  sessionId: "native-1",
};

/** One live runtime whose end can be held open, and the launch the Agent has at any moment. */
function subject(
  options: {
    stopping?: () => boolean;
    facts?: { runnerHold?: boolean; migrating?: boolean };
    backgroundTasks?: number;
    endFails?: boolean;
  } = {},
) {
  const first: Launch = {
    stopping: false,
    progress: new ProviderProgress(),
    backgroundTasks: { count: options.backgroundTasks ?? 0 } as never,
  };
  let current: Launch = first;
  const end = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const session = {} as AgentSession;
  const parked = [{ target: "#general" }] as never;
  const ports: RuntimeReleasePorts<Launch> = {
    launch: () => current,
    runtime: () => ({ session }) as never,
    restartConfig: () => restart,
    lastBusy: () => undefined,
    queuedForMs: () => undefined,
    resumable: () => true,
    sessionId: () => "native-1",
    isStopping: () => options.stopping?.() ?? false,
    daemonIdleFacts: () => (options.facts ?? {}) as never,
    hasParkedWork: () => true,
    flushParked: () => {},
    takeParked: () => parked,
    wake: async () => {},
    publish: () => {},
    handBackMentions: async () => {},
    release: async () => {
      entered.resolve();
      await end.promise;
      if (options.endFails) throw new Error("the process would not exit");
    },
  };
  return {
    release: new RuntimeRelease(ports),
    first,
    end,
    entered: entered.promise,
    supersede: () => {
      current = { stopping: false };
    },
  };
}

test("the Session is replaced with the deliveries parked while the runtime ended", async () => {
  const h = subject();
  const replaced: unknown[] = [];
  const replacing = h.release.endAndReplace("agent-a", replayRejectedEndPlan(restart), (parked) =>
    replaced.push(parked),
  );
  await h.entered;
  expect(h.release.isRecovering("agent-a")).toBe(true);
  h.end.resolve();

  expect(await replacing).toBe(true);
  expect(replaced).toHaveLength(1);
  expect(h.release.isRecovering("agent-a")).toBe(false);
});

test("a Start that took the Agent over while the runtime ended is not replaced under", async () => {
  const h = subject();
  const replaced: unknown[] = [];
  const replacing = h.release.endAndReplace("agent-a", replayRejectedEndPlan(restart), (parked) =>
    replaced.push(parked),
  );
  await h.entered;
  h.supersede();
  h.end.resolve();

  expect(await replacing).toBe(false);
  expect(replaced).toHaveLength(0);
  expect(h.release.isRecovering("agent-a")).toBe(false);
});

test("a Stop that arrived while the runtime ended wins", async () => {
  let stopping = false;
  const h = subject({ stopping: () => stopping });
  const replaced: unknown[] = [];
  const replacing = h.release.endAndReplace("agent-a", replayRejectedEndPlan(restart), (parked) =>
    replaced.push(parked),
  );
  await h.entered;
  stopping = true;
  h.end.resolve();

  expect(await replacing).toBe(false);
  expect(replaced).toHaveLength(0);
});

test("a runner hold, a migration or a running background task leaves the runtime alone", async () => {
  for (const options of [
    { facts: { runnerHold: true } },
    { facts: { migrating: true } },
    { backgroundTasks: 2 },
  ]) {
    const h = subject(options);
    const replaced: unknown[] = [];
    const outcome = await h.release.endAndReplace(
      "agent-a",
      replayRejectedEndPlan(restart),
      (parked) => replaced.push(parked),
    );

    expect(outcome).toBe(false);
    expect(replaced).toHaveLength(0);
    expect(h.release.isRecovering("agent-a")).toBe(false);
    expect(h.first.stopping).toBe(false);
  }
});

test("a runtime that would not exit keeps serving its launch, which is still judged for a hang", async () => {
  const h = subject({ endFails: true });
  h.end.resolve();
  const outcome = await h.release.endAndReplace(
    "agent-a",
    replayRejectedEndPlan(restart),
    () => {},
  );

  expect(outcome).toBe(false);
  expect(h.first.stopping).toBe(false);
  expect(h.first.progress).toBeDefined();
});
