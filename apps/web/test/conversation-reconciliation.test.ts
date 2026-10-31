import { expect, test } from "bun:test";

import { createConversationReconciler } from "#src/features/conversations/conversation-reconciliation";
import { mergeMessages } from "#src/features/conversations/conversation-messages";

const arrived = [{ id: "message-6", sequence: 6 }];
const fast = { retry: { firstMs: 5, maxMs: 20 }, random: () => 1 };

/** A read stuck on a dead connection: it never settles, only an abort ends it. */
const hang = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));

const timeout = () => Promise.reject(new DOMException("The read took too long", "TimeoutError"));

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a read that hit its deadline is read again after a backoff, with no new trigger", async () => {
  let reads = 0;
  const merged: unknown[] = [];
  const reconciler = createConversationReconciler(
    { afterSequence: 5 },
    () => (++reads === 1 ? timeout() : Promise.resolve(arrived)),
    (page) => merged.push(...page),
    fast,
  );

  // Before task #253 the failure was swallowed and the next trigger was the only way back.
  await reconciler.reconcile();
  expect(merged).toEqual([]);
  await wait(30);

  expect(reads).toBe(2);
  expect(merged).toEqual(arrived);
});

test("the page coming back abandons a read in flight and reads again at once", async () => {
  const signals: AbortSignal[] = [];
  const merged: unknown[] = [];
  const reconciler = createConversationReconciler(
    { afterSequence: 5 },
    (_cursor, signal) => {
      signals.push(signal);
      return signals.length === 1 ? hang(signal) : Promise.resolve(arrived);
    },
    (page) => merged.push(...page),
    fast,
  );

  const first = reconciler.reconcile();
  await reconciler.reconcile({ restart: true });
  await first;

  expect(signals[0]!.aborted).toBe(true);
  expect(signals).toHaveLength(2);
  expect(merged).toEqual(arrived);
});

test("a trigger during a read asks for one more read after it, not a second at once", async () => {
  let reads = 0;
  let finish: (messages: typeof arrived) => void = () => {};
  const reconciler = createConversationReconciler(
    { afterSequence: 5 },
    (_cursor, signal) => {
      reads += 1;
      return reads === 1
        ? new Promise<typeof arrived>((resolve, reject) => {
            finish = resolve;
            signal.addEventListener("abort", () => reject(signal.reason));
          })
        : Promise.resolve<typeof arrived>([]);
    },
    () => {},
    fast,
  );

  const first = reconciler.reconcile();
  const second = reconciler.reconcile();
  expect(reads).toBe(1);
  finish(arrived);
  await Promise.all([first, second]);

  expect(reads).toBe(2);
});

test("a failure waiting out its backoff is cut short only by a restart", async () => {
  let reads = 0;
  const reconciler = createConversationReconciler(
    { afterSequence: 5 },
    () => (++reads === 1 ? timeout() : Promise.resolve([])),
    () => {},
    { retry: { firstMs: 60_000, maxMs: 60_000 }, random: () => 1 },
  );

  await reconciler.reconcile();
  await reconciler.reconcile();
  expect(reads).toBe(1);
  await reconciler.reconcile({ restart: true });
  expect(reads).toBe(2);
  reconciler.stop();
});

test("a hidden page does not retry until it comes back", async () => {
  let reads = 0;
  let visible = false;
  const reconciler = createConversationReconciler(
    { afterSequence: 5 },
    () => (++reads === 1 ? timeout() : Promise.resolve([])),
    () => {},
    { ...fast, canRetry: () => visible },
  );

  await reconciler.reconcile();
  await wait(30);
  expect(reads).toBe(1);
  visible = true;
  await reconciler.reconcile({ restart: true });
  expect(reads).toBe(2);
});

test("the backoff doubles up to its cap", async () => {
  const at: number[] = [];
  const reconciler = createConversationReconciler(
    { afterSequence: 5 },
    () => {
      at.push(performance.now());
      return timeout();
    },
    () => {},
    { retry: { firstMs: 10, maxMs: 40 }, random: () => 1 },
  );

  await reconciler.reconcile();
  await wait(160);
  reconciler.stop();

  // Timers only ever fire late, so each wait is at least its share; the cap stops the doubling.
  const gaps = at.slice(1).map((time, index) => time - at[index]!);
  [10, 20, 40, 40].forEach((least, index) =>
    expect(gaps[index]!).toBeGreaterThanOrEqual(least - 1),
  );
  expect(gaps[3]!).toBeLessThan(75);
});

test("a message that arrives by realtime and by a catch-up read shows once", () => {
  const sent = { id: "message-6", sequence: 6, reactions: [] };
  expect(mergeMessages([sent], [{ ...sent }])).toHaveLength(1);
});

test("a stop leaves the reconciler able to read again, as a remount needs", async () => {
  let reads = 0;
  const reconciler = createConversationReconciler(
    { afterSequence: 5 },
    (_cursor, signal) => (++reads === 1 ? hang(signal) : Promise.resolve([])),
    () => {},
    fast,
  );

  const first = reconciler.reconcile();
  reconciler.stop();
  await first;
  await wait(30);
  expect(reads).toBe(1);

  await reconciler.reconcile();
  expect(reads).toBe(2);
});

test("a call made as a read ends is not lost", async () => {
  let reads = 0;
  let finish: () => void = () => {};
  const reconciler = createConversationReconciler(
    { afterSequence: 5 },
    () => {
      reads += 1;
      return reads === 1
        ? new Promise<typeof arrived>((resolve) => (finish = () => resolve([])))
        : Promise.resolve<typeof arrived>([]);
    },
    () => {},
    fast,
  );

  const first = reconciler.reconcile();
  finish();
  // After the read settles but before the round's promise does.
  await Promise.resolve();
  await Promise.resolve();
  void reconciler.reconcile();
  await first;
  await wait(5);
  expect(reads).toBe(2);
});

test("an open is caught up only once a read has landed, after what it read was merged", async () => {
  let reads = 0;
  const heard: boolean[] = [];
  const reconciler = createConversationReconciler(
    { afterSequence: 5 },
    () => (++reads === 1 ? timeout() : Promise.resolve(arrived)),
    () => heard.push(reconciler.caughtUp()),
    fast,
  );
  reconciler.subscribe(() => heard.push(reconciler.caughtUp()));

  // The unread divider waits on this (task #276): a failed read has not caught anything up.
  await reconciler.reconcile();
  expect(reconciler.caughtUp()).toBe(false);
  await wait(30);

  // The failure is heard (not caught up), then the merge is seen while still not caught up, so
  // the divider can land on what it brought.
  expect(heard).toEqual([false, false, true]);
  // Heard once: a later read merges as caught up, and no one is told again.
  await reconciler.reconcile();
  expect(heard).toEqual([false, false, true, true]);
});

test("an open is caught up through the newest message its first catch-up found", async () => {
  const reconciler = createConversationReconciler(
    { afterSequence: 5 },
    async (cursor) => (cursor.afterSequence === 5 ? [{ id: "m7", sequence: 7 }] : []),
    () => {},
  );
  expect(reconciler.caughtUpThrough()).toBeUndefined();
  await reconciler.reconcile();
  expect(reconciler.caughtUpThrough()).toBe(7);

  // What arrives later came while the conversation was open (task #358).
  reconciler.advance({ afterSequence: 9 });
  await reconciler.reconcile();
  expect(reconciler.caughtUpThrough()).toBe(7);

  // Caught up without a read: through the newest message the window holds, which a window
  // replaced since the open (a jump's) may have past the cursor.
  const idle = createConversationReconciler(
    { afterSequence: 5 },
    async () => [],
    () => {},
  );
  idle.caughtUpWithoutRead(8);
  expect(idle.caughtUpThrough()).toBe(8);
});

test("failed catch-ups are counted and heard until one lands", async () => {
  let reads = 0;
  let heard = 0;
  const reconciler = createConversationReconciler(
    { afterSequence: 5 },
    () => (++reads <= 2 ? timeout() : Promise.resolve(arrived)),
    () => {},
    { ...fast, canRetry: () => false },
  );
  reconciler.subscribe(() => heard++);

  await reconciler.reconcile();
  await reconciler.reconcile({ restart: true });
  expect(reconciler.failures()).toBe(2);
  expect(reconciler.caughtUp()).toBe(false);
  expect(heard).toBe(2);

  // The window's own read may be of history: it says nothing about the catch-up.
  reconciler.advance({ afterSequence: 6 });
  expect(reconciler.failures()).toBe(2);

  await reconciler.reconcile({ restart: true });
  expect(reconciler.failures()).toBe(0);
  expect(reconciler.caughtUp()).toBe(true);
  expect(heard).toBe(3);
});

test("a subscribe that found nothing new catches the page up without a read, unless one runs", async () => {
  let reads = 0;
  const idle = createConversationReconciler(
    { afterSequence: 5 },
    async () => {
      reads++;
      return [];
    },
    () => {},
  );
  let notified = 0;
  idle.subscribe(() => notified++);
  idle.caughtUpWithoutRead();
  expect({ caughtUp: idle.caughtUp(), notified, reads }).toEqual({
    caughtUp: true,
    notified: 1,
    reads: 0,
  });

  // A read under way decides: until it lands the page is not caught up.
  const reading = createConversationReconciler(
    { afterSequence: 5 },
    (_cursor, signal) => hang(signal),
    () => {},
  );
  void reading.reconcile();
  reading.caughtUpWithoutRead();
  expect(reading.caughtUp()).toBe(false);
  reading.stop();
});
