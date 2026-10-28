import { expect, test } from "bun:test";

import { createRealtimeWake } from "#src/features/realtime/realtime-wake";

function setup(connected = true) {
  let clock = 0;
  let reconnects = 0;
  const wake = createRealtimeWake({
    now: () => clock,
    connected: () => connected,
    reconnect: () => (reconnects += 1),
  });
  return {
    wake,
    at: (ms: number) => (clock = ms),
    reconnects: () => reconnects,
  };
}

test("a page back after a long while hidden reconnects; a quick look away does not", () => {
  const page = setup();
  page.wake.hidden();
  page.at(10_000);
  page.wake.visible();
  expect(page.reconnects()).toBe(0);

  page.wake.hidden();
  page.at(10_000 + 5 * 60_000);
  page.wake.visible();
  expect(page.reconnects()).toBe(1);
});

test("a visible page whose tick lands far too late slept, and reconnects", () => {
  const page = setup();
  page.wake.tick();
  page.at(5_000);
  page.wake.tick();
  expect(page.reconnects()).toBe(0);
  // The lid closed with the page on screen: the next tick comes six minutes later.
  page.at(6 * 60_000);
  page.wake.tick();
  expect(page.reconnects()).toBe(1);
});

test("ticks slowed down while hidden do not count as sleep", () => {
  const page = setup();
  page.wake.tick();
  page.wake.hidden();
  page.at(60_000);
  page.wake.tick();
  page.at(120_000);
  page.wake.tick();
  expect(page.reconnects()).toBe(0);
});

test("back online reconnects only a connection that still says it is connected", () => {
  const live = setup(true);
  live.wake.online();
  expect(live.reconnects()).toBe(1);

  const down = setup(false);
  down.wake.online();
  expect(down.reconnects()).toBe(0);
});

test("a connection the client is already reconnecting is left to it, whatever woke the page", () => {
  const page = setup(false);
  page.wake.hidden();
  page.at(5 * 60_000);
  page.wake.visible();
  page.wake.tick();
  page.at(10 * 60_000);
  page.wake.tick();
  page.wake.online();
  expect(page.reconnects()).toBe(0);
});
