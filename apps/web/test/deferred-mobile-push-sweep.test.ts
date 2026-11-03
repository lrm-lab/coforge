import { expect, test } from "bun:test";
import { releaseAll } from "#src/server/notifications/deferred-mobile-push-sweep.server";

/**
 * The waiting-phone sweep's work loop (task #467): every due person is looked at once, a few at a
 * time, and one person's failure neither stops the rest nor escapes the tick.
 */

test("every person is looked at once, at most `concurrency` at a time, past a failure", async () => {
  const seen: string[] = [];
  let running = 0;
  let peak = 0;
  const notifications = {
    releaseDeferred: async (userId: string) => {
      running += 1;
      peak = Math.max(peak, running);
      await Bun.sleep(5);
      running -= 1;
      seen.push(userId);
      if (userId === "p3") throw new Error("push service down");
      return { outcome: "sent" as const, sent: 1 };
    },
  };
  const people = Array.from({ length: 12 }, (_, index) => `p${index}`);
  await releaseAll(notifications, people, 4);
  expect(seen.sort()).toEqual([...people].sort());
  expect(peak).toBe(4);
});

test("no one due, nothing to do", async () => {
  let called = false;
  await releaseAll(
    { releaseDeferred: async () => ((called = true), { outcome: "gone", sent: 0 }) },
    [],
  );
  expect(called).toBe(false);
});
