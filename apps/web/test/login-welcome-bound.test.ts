import { afterEach, beforeEach, expect, jest, test } from "bun:test";

import { boundedWelcome, WELCOME_LIMIT_MS } from "#src/features/auth/login-art-state";

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

const shown = { hidden: () => false };

async function settled(promise: Promise<void>) {
  let done = false;
  void promise.then(() => (done = true));
  await Promise.resolve();
  await Promise.resolve();
  return () => done;
}

test("a greeting that never finishes still lets the sign-in leave after the limit", async () => {
  const done = await settled(boundedWelcome(() => new Promise<void>(() => {}), shown));
  jest.advanceTimersByTime(WELCOME_LIMIT_MS - 1);
  await Promise.resolve();
  expect(done()).toBe(false);
  jest.advanceTimersByTime(1);
  await Promise.resolve();
  await Promise.resolve();
  expect(done()).toBe(true);
});

test("a greeting that plays sooner lets it leave as soon as it has played", async () => {
  const done = await settled(boundedWelcome(() => Promise.resolve(), shown));
  expect(done()).toBe(true);
});

test("a greeting that fails, or throws, does not undo the sign-in", async () => {
  await expect(
    boundedWelcome(() => Promise.reject(new Error("no art")), shown),
  ).resolves.toBeUndefined();
  await expect(
    boundedWelcome(() => {
      throw new Error("no art");
    }, shown),
  ).resolves.toBeUndefined();
});

test("in a background tab it does not wait at all", async () => {
  let asked = false;
  const done = await settled(
    boundedWelcome(
      () => {
        asked = true;
        return new Promise<void>(() => {});
      },
      { hidden: () => true },
    ),
  );
  expect(done()).toBe(true);
  expect(asked).toBe(false);
});
