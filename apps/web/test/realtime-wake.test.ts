import { expect, test } from "bun:test";

import { createRealtimeWake, tokenExpiring } from "#src/features/realtime/realtime-wake";

function setup(connected = true) {
  let clock = 0;
  let reconnects = 0;
  const events: string[] = [];
  const wake = createRealtimeWake({
    now: () => clock,
    connected: () => connected,
    reconnect: () => {
      reconnects += 1;
      events.push("reconnect");
    },
    dropStaleToken: () => events.push("drop stale token"),
  });
  return {
    wake,
    at: (ms: number) => (clock = ms),
    reconnects: () => reconnects,
    events,
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

const jwt = (payload: object) =>
  `e30.${btoa(JSON.stringify(payload)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}.sig`;

test("a connection token is stale when it has expired or will within half a minute", () => {
  const now = 1_000_000_000_000;
  expect(tokenExpiring(jwt({ exp: now / 1000 + 300 }), now)).toBe(false);
  expect(tokenExpiring(jwt({ exp: now / 1000 + 10 }), now)).toBe(true);
  expect(tokenExpiring(jwt({ exp: now / 1000 - 90 }), now)).toBe(true);
  expect(tokenExpiring("not a token", now)).toBe(true);
  expect(tokenExpiring(undefined, now)).toBe(false);
});

test("every wake drops a stale token before anything reconnects, even one the client reconnects itself", () => {
  const live = setup(true);
  live.wake.online();
  expect(live.events).toEqual(["drop stale token", "reconnect"]);

  const reconnecting = setup(false);
  reconnecting.wake.online();
  reconnecting.wake.hidden();
  reconnecting.at(60_000);
  reconnecting.wake.visible();
  expect(reconnecting.events).toEqual(["drop stale token", "drop stale token"]);
});
