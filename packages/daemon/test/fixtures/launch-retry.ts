import { AgentControl, type LaunchRetryScheduler } from "#src/agent-runtime/agent-control";
import { AgentSessions } from "#src/agent-runtime/agent-session";
import { AgentRuntimeState, type AgentRuntimeRecord } from "#src/agent-runtime/agent-runtime-state";
import type {
  AgentControlResult,
  AgentStartIntent,
  SessionIdentity,
} from "@lrm/coforge-sdk/internal";

/** A scheduler that only records what `AgentControl` asked for, so a test drives every retry
 * itself instead of sleeping through real cooldowns. */
export function manualScheduler() {
  type Entry = { callback: () => void; delayMs: number; cancelled: boolean };
  const entries: Entry[] = [];
  const scheduler: LaunchRetryScheduler = {
    schedule(callback, delayMs) {
      const entry: Entry = { callback, delayMs, cancelled: false };
      entries.push(entry);
      return entry;
    },
    cancel(handle) {
      (handle as Entry).cancelled = true;
    },
  };
  const live = () => entries.filter((entry) => !entry.cancelled);
  return {
    scheduler,
    entries,
    live,
    delays: () => entries.map((entry) => entry.delayMs),
    /** Fires the most recently armed retry and lets its `state.run` chain settle. */
    async fireLatest(): Promise<void> {
      const entry = live().at(-1);
      if (!entry) throw new Error("no retry armed");
      entry.callback();
      await settle();
    },
  };
}

/** Lets the fire-and-forget retry chain in `AgentControl` finish (its store is in memory, so a
 * few macrotask turns are enough). */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

export const startIntent: AgentStartIntent = {
  protocolMajor: 1,
  requestId: "r",
  workspaceId: "w",
  computerId: "c",
  agentId: "a",
  provider: "pi",
  model: "default",
  reasoning: "",
  controlEpoch: 1,
  launchId: "launch-1",
};

/** An `AgentControl` over an in-memory record whose launches are the given function. */
export function harness(launch: (attempt: number) => Promise<SessionIdentity | undefined>) {
  let record: AgentRuntimeRecord | undefined;
  const results: AgentControlResult[] = [];
  const launches: number[] = [];
  const settled: string[] = [];
  const state = new AgentRuntimeState({
    listAgentIds: async () => [],
    read: async () => record && structuredClone(record),
    write: async (_id, value) => {
      record = structuredClone(value);
    },
    clearWorkspace: async () => {},
  });
  const timers = manualScheduler();
  const control = new AgentControl(
    "daemon",
    state,
    new AgentSessions(state, async () => {}),
    {
      running: () => false,
      rebind: async () => undefined,
      stop: async () => undefined,
      startSettled(agentId) {
        settled.push(agentId);
      },
      async launch() {
        launches.push(launches.length + 1);
        return launch(launches.length);
      },
      async result(result) {
        results.push(result);
      },
    },
    timers.scheduler,
  );
  return { control, results, launches, timers, settled, record: () => record };
}
