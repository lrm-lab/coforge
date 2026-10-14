import { expect, test } from "bun:test";

import { createAgentDirectoryInvalidator } from "#src/features/agents/workspace-agents-realtime";

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
