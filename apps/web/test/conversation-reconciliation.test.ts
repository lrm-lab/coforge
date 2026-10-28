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
