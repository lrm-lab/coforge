import { describe, expect, test } from "bun:test";

import { mergeAgentStatusSnapshot } from "#src/features/agents/agent-status-realtime";
import { AGENT_MASCOTS } from "#src/features/agents/agent-mascot";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";
import type { ExtraAgent } from "#src/features/agents/extra-agent";
import type { LiveAgent } from "#src/features/agents/workspace-agents-realtime";
import {
  createAgentDirectoryInvalidator,
  refreshedAgents,
} from "#src/features/agents/workspace-agents-refresh";

const live = (id: string): LiveAgent => ({
  id,
  name: id,
  displayName: id,
  status: { value: "inactive", expiresAt: null },
});

test("coalesces a burst of Agent directory events into one invalidation", () => {
  let nextTimer = 0;
  const callbacks = new Map<number, () => void>();
  const cleared: number[] = [];
  const scheduler = {
    set(callback: () => void) {
      const timer = ++nextTimer;
      callbacks.set(timer, callback);
      return timer;
    },
    clear(timer: number) {
      cleared.push(timer);
      callbacks.delete(timer);
    },
  };
  let invalidations = 0;
  const invalidator = createAgentDirectoryInvalidator(() => {
    invalidations += 1;
  }, scheduler);

  invalidator.schedule();
  invalidator.schedule();
  expect(cleared).toEqual([1]);
  expect(invalidations).toBe(0);
  callbacks.get(2)?.();
  expect(invalidations).toBe(1);
  invalidator.cancel();
  expect(invalidations).toBe(1);
});

describe("refreshedAgents", () => {
  const roster = [live("own")];
  const extra = (id: string): ExtraAgent => ({
    id,
    name: id,
    displayName: id,
    avatarUrl: "",
    mascot: AGENT_MASCOTS[0],
    visibility: AGENT_VISIBILITY.PRIVATE,
  });

  test("a refresh that read the extras again is authoritative: an extra it dropped is gone", () => {
    const current = refreshedAgents(roster, [extra("x"), extra("y")]);
    expect(current.map((agent) => agent.id)).toEqual(["own", "x", "y"]);
    const refreshed = refreshedAgents(roster, [extra("y")]);
    expect(mergeAgentStatusSnapshot(current, refreshed).map((agent) => agent.id)).toEqual([
      "own",
      "y",
    ]);
  });

  test("the extras it read are marked and start inactive", () => {
    const [, first] = refreshedAgents(roster, [extra("x")]);
    expect(first).toMatchObject({ id: "x", isExtra: true, status: { value: "inactive" } });
  });

  test("with no extras read the roster stands alone", () => {
    expect(refreshedAgents(roster, undefined)).toEqual(roster);
    expect(refreshedAgents(roster, [])).toEqual(roster);
  });
});
