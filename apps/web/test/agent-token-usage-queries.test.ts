import { describe, expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import {
  AGENT_TOKEN_USAGE_INVALIDATE_WINDOW_MS,
  agentTokenUsageKeys,
  createAgentTokenUsageInvalidator,
  invalidateAgentTokenUsageQueries,
} from "#src/features/agents/agent-token-usage-queries";

function manualScheduler() {
  let nextTimer = 0;
  const callbacks = new Map<number, { callback: () => void; delayMs: number }>();
  const cleared: number[] = [];
  return {
    scheduler: {
      set(callback: () => void, delayMs: number) {
        const id = ++nextTimer;
        callbacks.set(id, { callback, delayMs });
        return id;
      },
      clear(timer: number) {
        cleared.push(timer);
        callbacks.delete(timer);
      },
    },
    callbacks,
    cleared,
    fire(timer: number) {
      const entry = callbacks.get(timer);
      callbacks.delete(timer);
      entry?.callback();
    },
  };
}

describe("createAgentTokenUsageInvalidator", () => {
  test("coalesces multiple agent turns within a bounded window without resetting the timer", () => {
    const timers = manualScheduler();
    const flushes: { agentIds: string[]; allAgents: boolean }[] = [];
    const invalidator = createAgentTokenUsageInvalidator((batch) => {
      flushes.push({
        agentIds: [...batch.agentIds].sort(),
        allAgents: batch.allAgents,
      });
    }, timers.scheduler);

    invalidator.schedule("agent-1");
    invalidator.schedule("agent-2");
    invalidator.schedule("agent-1");

    expect(timers.callbacks.size).toBe(1);
    expect(timers.callbacks.get(1)?.delayMs).toBe(AGENT_TOKEN_USAGE_INVALIDATE_WINDOW_MS);
    expect(timers.cleared).toEqual([]);
    expect(flushes).toEqual([]);

    timers.fire(1);
    expect(flushes).toEqual([{ agentIds: ["agent-1", "agent-2"], allAgents: false }]);

    invalidator.scheduleAll();
    invalidator.schedule("agent-3");
    expect(timers.callbacks.size).toBe(1);
    timers.fire(2);
    expect(flushes).toEqual([
      { agentIds: ["agent-1", "agent-2"], allAgents: false },
      { agentIds: [], allAgents: true },
    ]);
  });

  test("cancel drops queued agents and clears pending timer", () => {
    const timers = manualScheduler();
    let flushCount = 0;
    const invalidator = createAgentTokenUsageInvalidator(() => {
      flushCount += 1;
    }, timers.scheduler);

    invalidator.schedule("agent-1");
    invalidator.cancel();
    expect(timers.cleared).toEqual([1]);
    expect(timers.callbacks.size).toBe(0);
    expect(flushCount).toBe(0);
  });
});

describe("invalidateAgentTokenUsageQueries", () => {
  test("marks inactive queries stale without refetching and scopes per-agent invalidation", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: 30_000, retry: false } },
    });
    let agent1Fetches = 0;
    let agent2Fetches = 0;
    let workspaceFetches = 0;

    const agent1Key = agentTokenUsageKeys.agentRange("agent-1", 7, "UTC");
    const agent2Key = agentTokenUsageKeys.agentRange("agent-2", 7, "UTC");
    const workspaceKey = agentTokenUsageKeys.workspaceRange("ws-1", 7, "UTC");

    await queryClient.prefetchQuery({
      queryKey: agent1Key,
      queryFn: async () => {
        agent1Fetches += 1;
        return { v: agent1Fetches };
      },
    });
    await queryClient.prefetchQuery({
      queryKey: agent2Key,
      queryFn: async () => {
        agent2Fetches += 1;
        return { v: agent2Fetches };
      },
    });
    await queryClient.prefetchQuery({
      queryKey: workspaceKey,
      queryFn: async () => {
        workspaceFetches += 1;
        return { v: workspaceFetches };
      },
    });

    expect(queryClient.getQueryState(agent1Key)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(agent2Key)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(workspaceKey)?.isInvalidated).toBe(false);

    invalidateAgentTokenUsageQueries(queryClient, "ws-1", {
      agentIds: new Set(["agent-1"]),
      allAgents: false,
    });

    expect(queryClient.getQueryState(agent1Key)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(agent2Key)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(workspaceKey)?.isInvalidated).toBe(true);
    expect(agent1Fetches).toBe(1);
    expect(agent2Fetches).toBe(1);
    expect(workspaceFetches).toBe(1);

    invalidateAgentTokenUsageQueries(queryClient, "ws-1", {
      agentIds: new Set(),
      allAgents: true,
    });
    expect(queryClient.getQueryState(agent2Key)?.isInvalidated).toBe(true);
    expect(agent2Fetches).toBe(1);
  });

  test("immediately refetches active observers while leaving unrelated active agents untouched", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: 30_000, retry: false } },
    });
    let agent1Fetches = 0;
    let agent2Fetches = 0;
    let workspaceFetches = 0;

    const agent1Key = agentTokenUsageKeys.agentRange("agent-1", 7, "UTC");
    const agent2Key = agentTokenUsageKeys.agentRange("agent-2", 7, "UTC");
    const workspaceKey = agentTokenUsageKeys.workspaceRange("ws-1", 7, "UTC");

    const agent1Observer = new QueryObserver(queryClient, {
      queryKey: agent1Key,
      queryFn: async () => ({ v: ++agent1Fetches }),
    });
    const agent2Observer = new QueryObserver(queryClient, {
      queryKey: agent2Key,
      queryFn: async () => ({ v: ++agent2Fetches }),
    });
    const workspaceObserver = new QueryObserver(queryClient, {
      queryKey: workspaceKey,
      queryFn: async () => ({ v: ++workspaceFetches }),
    });

    const unsub1 = agent1Observer.subscribe(() => {});
    const unsub2 = agent2Observer.subscribe(() => {});
    const unsubWs = workspaceObserver.subscribe(() => {});
    try {
      await Promise.all([
        agent1Observer.refetch(),
        agent2Observer.refetch(),
        workspaceObserver.refetch(),
      ]);
      expect([agent1Fetches, agent2Fetches, workspaceFetches]).toEqual([1, 1, 1]);

      await invalidateAgentTokenUsageQueries(queryClient, "ws-1", {
        agentIds: new Set(["agent-1"]),
        allAgents: false,
      });

      expect(agent1Fetches).toBe(2);
      expect(agent2Fetches).toBe(1);
      expect(workspaceFetches).toBe(2);
    } finally {
      unsub1();
      unsub2();
      unsubWs();
    }
  });
});
