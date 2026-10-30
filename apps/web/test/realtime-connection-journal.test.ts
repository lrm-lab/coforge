import { expect, test } from "bun:test";

import { createConnectionJournal } from "#src/features/realtime/connection-journal";

function setup() {
  let clock = 0;
  const lines: string[] = [];
  const journal = createConnectionJournal({
    now: () => clock,
    log: {
      info: (line: string) => lines.push(`info ${line}`),
      warn: (line: string) => lines.push(`warn ${line}`),
    },
  });
  return { journal, lines, at: (ms: number) => (clock = ms) };
}

test("a drop and the reconnect after it say why, every error on the way, and how long it took", () => {
  const { journal, lines, at } = setup();
  at(60_000);
  journal.connecting({ code: 1, reason: "transport closed" });
  at(61_000);
  journal.error({ type: "transport", error: { code: 2, message: "transport closed" } });
  at(65_000);
  journal.error({ type: "connect", error: { code: 1, message: "timeout" } });
  at(71_000);
  journal.error({
    type: "connectToken",
    error: { code: 5, message: "TypeError: Failed to fetch" },
  });
  at(72_500);
  journal.connected();
  expect(lines).toEqual([
    "info realtime connecting: 1 transport closed",
    "warn realtime transport error: 2 transport closed",
    "warn realtime connect error: 1 timeout",
    "warn realtime connectToken error: 5 TypeError: Failed to fetch",
    "info realtime connected after 12.5s, 3 errors",
  ]);
});

test("a later drop times its reconnect and counts its errors afresh", () => {
  const { journal, lines, at } = setup();
  journal.connecting({ code: 0, reason: "connect called" });
  journal.error({ type: "connect", error: { code: 1, message: "timeout" } });
  at(300);
  journal.connected();
  at(10_000);
  journal.connecting({ code: 2, reason: "no ping" });
  at(11_000);
  journal.connected();
  expect(lines.at(-1)).toBe("info realtime connected after 1.0s, 0 errors");
});

test("a disconnect for good warns; the page's own disconnect does not", () => {
  const { journal, lines } = setup();
  journal.disconnected({ code: 0, reason: "disconnect called" });
  journal.disconnected({ code: 1, reason: "unauthorized" });
  expect(lines).toEqual([
    "info realtime disconnected: 0 disconnect called",
    "warn realtime disconnected: 1 unauthorized",
  ]);
});

test("a slow connection token fetch is reported; a quick one is not, and a failure is the client's error", async () => {
  const { journal, lines, at } = setup();
  const fetchTaking = (ms: number, failure?: Error) =>
    journal.timeToken(async () => {
      at(ms);
      if (failure) throw failure;
      return "token";
    });

  expect(await fetchTaking(120)()).toBe("token");
  at(0);
  expect(await fetchTaking(4_200)()).toBe("token");
  at(0);
  const failure = new TypeError("Failed to fetch");
  await expect(fetchTaking(900, failure)()).rejects.toBe(failure);
  expect(lines).toEqual(["warn realtime connection token took 4.2s"]);
});
