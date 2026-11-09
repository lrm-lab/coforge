import { expect, test } from "bun:test";
import type { AgentConfigSync, RuntimeProvider } from "@lrm/coforge-sdk/internal";
import type { RestartRuntimeFields } from "#src/agent-runtime/agent-process-manager";
import { AgentConfigApply, CONFIG_APPLY_RETRY_MS } from "#src/daemon-runtime/agent-config-apply";
import type { ColdIdleAgent } from "#src/daemon-runtime/cold-idle-sweep";
import { captureDaemonLogs } from "./log-capture";

const AGENT = "agent-a";

function push(revision: number, overrides: Partial<AgentConfigSync> = {}): AgentConfigSync {
  return {
    protocolMajor: 1,
    workspaceId: "workspace-a",
    computerId: "computer-a",
    agentId: AGENT,
    provider: "claude-code",
    model: `model-${revision}`,
    reasoning: "high",
    revision,
    ...overrides,
  };
}

/** One Agent as the module's ports see it: a live runtime or not, a restart config or not. */
function fixture(
  initial: {
    live?: Partial<ColdIdleAgent> | false;
    launching?: boolean;
    restart?: RuntimeProvider | false;
    stopResult?: "stopped" | "busy" | "failed";
  } = {},
) {
  const state = {
    live:
      initial.live === false
        ? undefined
        : ({
            agentId: AGENT,
            provider: "claude-code",
            busyReason: undefined,
            sessionId: "session-1",
            lastEventAtMs: 0,
            ...initial.live,
          } as ColdIdleAgent),
    launching: initial.launching ?? false,
    /** The identity of the Agent's current launch, in flight or live: one object per launch. */
    launch: initial.live === false && !initial.launching ? undefined : ({} as object | undefined),
    restart: initial.restart === false ? undefined : (initial.restart ?? "claude-code"),
  };
  const calls: string[] = [];
  const replaced: RestartRuntimeFields[] = [];
  const stops: string[] = [];
  const timers: Array<{ run: () => Promise<void>; ms: number; cancelled: boolean }> = [];
  let stopResult = initial.stopResult ?? "stopped";
  const apply = new AgentConfigApply({
    agent: () => state.live,
    launching: () => state.launching,
    launchOf: () => state.launch,
    restartProvider: () => state.restart,
    replaceRestartRuntime: (_agentId, fields) => {
      calls.push("replace");
      replaced.push(fields);
    },
    stopIdle: async (agentId) => {
      calls.push("stop");
      stops.push(agentId);
      if (stopResult === "stopped") {
        state.live = undefined;
        state.launch = undefined;
      }
      return stopResult;
    },
    schedule: (run, ms) => {
      const timer = { run, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });
  /** The timers still armed. */
  const armed = () => timers.filter((timer) => !timer.cancelled);
  return {
    apply,
    state,
    calls,
    replaced,
    stops,
    timers,
    armed,
    setStopResult: (result: "stopped" | "busy" | "failed") => {
      stopResult = result;
    },
    /** Fires the armed retry timer, as the clock would. */
    async fire() {
      const [timer] = armed();
      if (!timer) throw new Error("no retry timer is armed");
      timer.cancelled = true;
      await timer.run();
    },
  };
}

const eventsOf = (records: readonly { properties: Record<string, unknown> }[]) =>
  records
    .filter((record) => record.properties.event === "agent.runtime.config_push")
    .map((record) => record.properties.outcome);

test("a busy Agent is not stopped until it is idle, and the restart config holds the new model at once", async () => {
  const f = fixture({ live: { busyReason: "live_turn" } });
  const { records } = await captureDaemonLogs(async () => {
    await f.apply.accept(push(2));
    expect(f.stops).toEqual([]);
    // The restart config already carries the pushed model, so any wake before the stop uses it.
    expect(f.replaced).toEqual([
      { provider: "claude-code", model: "model-2", modelProvider: undefined, reasoning: "high" },
    ]);
    // A turn ending while it is still busy changes nothing.
    await f.apply.settle(AGENT);
    expect(f.stops).toEqual([]);
    f.state.live = { ...f.state.live!, busyReason: undefined };
    await f.apply.settle(AGENT);
  });
  expect(f.stops).toEqual([AGENT]);
  expect(eventsOf(records)).toEqual(["pending", "idle_stop"]);
});

test("a stale revision is dropped, equal to or older than the one held", async () => {
  const f = fixture({ live: { busyReason: "live_turn" } });
  const { records } = await captureDaemonLogs(async () => {
    await f.apply.accept(push(5));
    await f.apply.accept(push(5, { model: "same-revision" }));
    await f.apply.accept(push(4, { model: "older" }));
  });
  expect(f.replaced.map((fields) => fields.model)).toEqual(["model-5"]);
  expect(eventsOf(records)).toEqual(["pending", "stale", "stale"]);
});

test("a newer push replaces the pending one, and the Agent restarts once", async () => {
  const f = fixture({ live: { busyReason: "live_turn" } });
  await f.apply.accept(push(2));
  await f.apply.accept(push(3));
  expect(f.replaced.map((fields) => fields.model)).toEqual(["model-2", "model-3"]);
  f.state.live = { ...f.state.live!, busyReason: undefined };
  await f.apply.settle(AGENT);
  await f.apply.settle(AGENT);
  expect(f.stops).toHaveLength(1);
});

test("a Start that launched at the pending revision cancels the apply and later pushes below it are dropped", async () => {
  const f = fixture({ live: { busyReason: "live_turn" } });
  await f.apply.accept(push(3));
  f.apply.launched(AGENT, 3);
  expect(f.armed()).toEqual([]);
  f.state.live = { ...f.state.live!, busyReason: undefined };
  await f.apply.settle(AGENT);
  expect(f.stops).toEqual([]);
  const { records } = await captureDaemonLogs(async () => f.apply.accept(push(3)));
  expect(eventsOf(records)).toEqual(["stale"]);
});

test("a Start launched below the pending revision leaves it pending", async () => {
  const f = fixture({ live: { busyReason: "live_turn" } });
  await f.apply.accept(push(4));
  f.apply.launched(AGENT, 3);
  f.state.live = { ...f.state.live!, busyReason: undefined };
  await f.apply.settle(AGENT);
  expect(f.stops).toHaveLength(1);
});

test("a Start that carries no revision records nothing and cancels nothing", async () => {
  const f = fixture({ live: { busyReason: "live_turn" } });
  await f.apply.accept(push(2));
  f.apply.launched(AGENT, undefined);
  expect(f.armed()).toHaveLength(1);
  await f.apply.accept(push(3));
  expect(f.replaced.map((fields) => fields.model)).toEqual(["model-2", "model-3"]);
});

test("a push not newer than the revision a Start launched with is dropped", async () => {
  const f = fixture({ live: false });
  f.apply.launched(AGENT, 6);
  const { records } = await captureDaemonLogs(async () => {
    await f.apply.accept(push(6));
    await f.apply.accept(push(5));
  });
  expect(f.calls).toEqual([]);
  expect(eventsOf(records)).toEqual(["stale", "stale"]);
});

test("a Stop cancels the pending apply but keeps the revision held", async () => {
  const f = fixture({ live: { busyReason: "live_turn" } });
  await f.apply.accept(push(2));
  f.apply.stopped(AGENT);
  expect(f.armed()).toEqual([]);
  f.state.live = { ...f.state.live!, busyReason: undefined };
  await f.apply.settle(AGENT);
  expect(f.stops).toEqual([]);
  const { records } = await captureDaemonLogs(async () => await f.apply.accept(push(2)));
  expect(eventsOf(records)).toEqual(["stale"]);
});

test("with no live runtime the restart config is updated and no process is touched", async () => {
  const f = fixture({ live: false });
  const { records } = await captureDaemonLogs(async () => await f.apply.accept(push(2)));
  expect(f.calls).toEqual(["replace"]);
  expect(f.replaced[0]).toMatchObject({ model: "model-2", provider: "claude-code" });
  expect(f.armed()).toEqual([]);
  expect(eventsOf(records)).toEqual(["applied"]);
});

test("with no live runtime a push for another provider is dropped and touches nothing", async () => {
  const f = fixture({ live: false });
  const { records } = await captureDaemonLogs(
    async () => await f.apply.accept(push(2, { provider: "codex" })),
  );
  expect(f.calls).toEqual([]);
  expect(eventsOf(records)).toEqual(["provider_mismatch"]);
});

test("with neither a runtime nor a restart config the revision is held and the server decides", async () => {
  const f = fixture({ live: false, restart: false });
  const { records } = await captureDaemonLogs(async () => {
    await f.apply.accept(push(2));
    await f.apply.accept(push(2));
  });
  expect(f.calls).toEqual([]);
  expect(eventsOf(records)).toEqual(["no_restart_config", "stale"]);
});

test("a launch in flight counts as live: the apply waits for it", async () => {
  const f = fixture({ live: false, launching: true, restart: false });
  await f.apply.accept(push(2));
  expect(f.calls).toEqual([]);
  expect(f.armed()).toHaveLength(1);
});

test("a push for another provider than the live runtime's is dropped: no pending, no stop, no revision held", async () => {
  const f = fixture({ live: { busyReason: "live_turn" } });
  const { records } = await captureDaemonLogs(async () => {
    await f.apply.accept(push(2, { provider: "codex" }));
    f.state.live = { ...f.state.live!, busyReason: undefined };
    await f.apply.settle(AGENT);
    // The dropped push held no revision, so the same revision can still arrive properly.
    await f.apply.accept(push(2));
  });
  expect(f.stops).toEqual([AGENT]);
  // Once on accept, once more right before the stop.
  expect(f.calls).toEqual(["replace", "replace", "stop"]);
  expect(eventsOf(records)).toEqual(["provider_mismatch", "pending", "idle_stop"]);
});

test("a launch in flight that turns out to run another provider drops the apply", async () => {
  const f = fixture({ live: false, launching: true, restart: false });
  await f.apply.accept(push(2));
  f.state.live = {
    agentId: AGENT,
    provider: "codex",
    busyReason: undefined,
    sessionId: "session-1",
    lastEventAtMs: 0,
  };
  const { records } = await captureDaemonLogs(async () => await f.apply.settle(AGENT));
  expect(f.stops).toEqual([]);
  expect(f.armed()).toEqual([]);
  expect(eventsOf(records)).toEqual(["provider_mismatch"]);
});

test("a live runtime that ends before it was idle is settled as no runtime", async () => {
  const f = fixture({ live: { busyReason: "live_turn" } });
  await f.apply.accept(push(2));
  f.state.live = undefined;
  const { records } = await captureDaemonLogs(async () => await f.apply.settle(AGENT));
  expect(f.stops).toEqual([]);
  expect(f.armed()).toEqual([]);
  expect(eventsOf(records)).toEqual(["applied"]);
});

test("an Agent with no reported session is never stopped", async () => {
  const f = fixture({ live: { sessionId: undefined } });
  await f.apply.accept(push(2));
  expect(f.stops).toEqual([]);
  expect(f.armed()).toHaveLength(1);
});

test("the retry timer exists only while an apply is pending and applies when the Agent goes idle", async () => {
  const f = fixture({ live: { busyReason: "background_tasks" } });
  expect(f.timers).toEqual([]);
  await f.apply.accept(push(2));
  expect(f.armed().map((timer) => timer.ms)).toEqual([CONFIG_APPLY_RETRY_MS]);
  // A background task ends without a turn end: only the timer notices.
  await f.fire();
  expect(f.armed()).toHaveLength(1);
  f.state.live = { ...f.state.live!, busyReason: undefined };
  await f.fire();
  expect(f.stops).toHaveLength(1);
  expect(f.armed()).toEqual([]);
});

test("a stop that found the Agent busy again stays pending; one that failed is dropped", async () => {
  const f = fixture({ stopResult: "busy" });
  await f.apply.accept(push(2));
  expect(f.armed()).toHaveLength(1);
  f.setStopResult("failed");
  const { records } = await captureDaemonLogs(async () => {
    await f.fire();
  });
  expect(f.armed()).toEqual([]);
  expect(eventsOf(records)).toContain("stop_failed");
});

test("dispose cancels the retry timer", async () => {
  const f = fixture({ live: { busyReason: "live_turn" } });
  await f.apply.accept(push(2));
  f.apply.dispose();
  expect(f.armed()).toEqual([]);
});

test("a log never carries the pushed configuration", async () => {
  const f = fixture({ live: { busyReason: "live_turn" } });
  const { records } = await captureDaemonLogs(
    async () =>
      await f.apply.accept(
        push(2, { model: "secret-model", providerConfig: { kind: "coforge", providerId: "p-1" } }),
      ),
  );
  expect(JSON.stringify(records.map((record) => record.properties))).not.toContain("secret-model");
});

test("the held revisions are what a push or a revisioned Start last set, and never go backwards", async () => {
  const f = fixture({ live: { busyReason: "live_turn" } });
  expect([...f.apply.appliedRevisions()]).toEqual([]);
  await f.apply.accept(push(3));
  f.apply.launched(AGENT, 2);
  f.apply.launched("agent-b", 6);
  await f.apply.accept(push(1));
  expect([...f.apply.appliedRevisions()].sort()).toEqual([
    [AGENT, 3],
    ["agent-b", 6],
  ]);
});

test("a sync accepted during a launch re-applies its fields right before the idle stop", async () => {
  const f = fixture({ live: false, launching: true });
  await f.apply.accept(push(2));
  // The launch finishes, and the process manager has set the restart config from the launch's own
  // older config meanwhile; the stop must put the pending sync's fields back first.
  f.state.launching = false;
  f.state.live = {
    ...f.state.live,
    agentId: AGENT,
    provider: "claude-code",
    sessionId: "s",
  } as never;
  const before = f.calls.length;
  await f.apply.settle(AGENT);
  expect(f.stops).toEqual([AGENT]);
  expect(f.calls.slice(before)).toEqual(["replace", "stop"]);
  expect(f.replaced.at(-1)?.model).toBe("model-2");
});

test("a failed idle stop releases the held revision, so ready republishes and a retry is accepted", async () => {
  const f = fixture({ stopResult: "failed" });
  await f.apply.accept(push(2));
  expect(f.stops).toEqual([AGENT]);
  expect(f.apply.appliedRevisions().has(AGENT)).toBe(false);

  f.setStopResult("stopped");
  await f.apply.accept(push(2));
  expect(f.stops).toEqual([AGENT, AGENT]);
});

test("a failed stop keeps a revision a later Start held", async () => {
  const f = fixture({ live: { busyReason: "live_turn" }, stopResult: "failed" });
  await f.apply.accept(push(2));
  f.apply.launched(AGENT, 5);
  expect(f.apply.appliedRevisions().get(AGENT)).toBe(5);
});

test("a launch that began after the sync retires the pending apply instead of killing it again", async () => {
  const f = fixture({ live: { busyReason: "live_turn" } });
  const { records } = await captureDaemonLogs(async () => {
    await f.apply.accept(push(2));
    // The Agent exited and a Daemon-initiated wake launched on the restart config the sync set.
    f.state.launch = {};
    f.state.live = { ...f.state.live!, busyReason: undefined };
    await f.apply.settle(AGENT);
  });
  expect(f.stops).toEqual([]);
  expect(f.armed()).toEqual([]);
  expect(eventsOf(records)).toEqual(["pending", "applied"]);
});

test("a launch already in flight when the sync arrived is still restarted", async () => {
  const f = fixture({ live: false, launching: true });
  await f.apply.accept(push(2));
  f.state.launching = false;
  f.state.live = {
    agentId: AGENT,
    provider: "claude-code",
    busyReason: undefined,
    sessionId: "session-1",
    lastEventAtMs: 0,
  } as never;
  await f.apply.settle(AGENT);
  expect(f.stops).toEqual([AGENT]);
});

test("a Memory Agent is never stopped: its restart config is updated, the revision held, nothing pending", async () => {
  const f = fixture({ live: { busyReason: "memory_agent" } });
  const { records } = await captureDaemonLogs(async () => {
    await f.apply.accept(push(2));
    await f.apply.settle(AGENT);
  });
  expect(f.stops).toEqual([]);
  expect(f.armed()).toEqual([]);
  expect(f.replaced.map((fields) => fields.model)).toEqual(["model-2"]);
  expect(f.apply.appliedRevisions().get(AGENT)).toBe(2);
  expect(eventsOf(records)).toEqual(["memory_agent"]);
});

test("a launch that turns out to be a Memory Agent drops its pending apply", async () => {
  const f = fixture({ live: false, launching: true });
  await f.apply.accept(push(2));
  f.state.launching = false;
  f.state.live = {
    agentId: AGENT,
    provider: "claude-code",
    busyReason: "memory_agent",
    sessionId: "session-1",
    lastEventAtMs: 0,
  } as never;
  await f.apply.settle(AGENT);
  expect(f.stops).toEqual([]);
  expect(f.armed()).toEqual([]);
  expect(f.replaced.at(-1)?.model).toBe("model-2");
});

test.each([
  ["a lower revision", 1],
  ["no revision", undefined],
] as const)(
  "a Start with %s launches the old fields: the pending apply survives a launch it started",
  async (_name, revision) => {
    const f = fixture({ live: { busyReason: "live_turn" } });
    await f.apply.accept(push(2));
    // The Start launches from its own, older, fields, so the launch it began is not the new config.
    f.apply.launched(AGENT, revision);
    f.state.launch = {};
    f.state.live = { ...f.state.live!, busyReason: undefined };
    await f.apply.settle(AGENT);
    expect(f.stops).toEqual([AGENT]);
    expect(f.calls.slice(-2)).toEqual(["replace", "stop"]);
  },
);

test("disposing drops every pending apply and its timer", async () => {
  const f = fixture({ live: { busyReason: "live_turn" } });
  await f.apply.accept(push(2));
  expect(f.armed()).toHaveLength(1);
  f.apply.dispose();
  expect(f.armed()).toEqual([]);
  f.state.live = { ...f.state.live!, busyReason: undefined };
  await f.apply.settle(AGENT);
  expect(f.stops).toEqual([]);
});
