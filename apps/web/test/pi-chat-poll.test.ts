import { expect, test } from "bun:test";
import {
  PI_CHAT_CLIENT_DEADLINE_MS,
  PI_CHAT_POLL_FIRST_INTERVAL_MS,
  awaitPiChat,
} from "#src/features/pi-chat/pi-chat-poll";
import { isAppErrorCode } from "#src/lib/app-error";
import type { PiChatRead } from "#src/server/pi-chat/pi-chat-gateway.server";
import { PI_CHAT_REPLY_TTL_SECONDS } from "#src/server/pi-chat/pi-chat-results.server";

/** A clock the test advances only by sleeping, and a read that answers from a script. */
function harness(script: Array<PiChatRead | Error>) {
  let now = 0;
  const sleeps: number[] = [];
  let reads = 0;
  return {
    sleeps,
    reads: () => reads,
    run: () =>
      awaitPiChat({
        read: async () => {
          const next = script[Math.min(reads++, script.length - 1)]!;
          if (next instanceof Error) throw next;
          return next;
        },
        signal: new AbortController().signal,
        now: () => now,
        sleep: async (ms) => {
          sleeps.push(ms);
          now += ms;
        },
      }),
  };
}

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

test("a quick reply is read within the first fraction of a second, then asked for less often", async () => {
  const { run, sleeps, reads } = harness([
    ...Array(8).fill({ status: "pending" }),
    { status: "ready", result: { sessions: [] } },
  ]);
  expect(await run()).toEqual({ sessions: [] });
  expect(reads()).toBe(9);
  expect(sleeps[0]).toBe(PI_CHAT_POLL_FIRST_INTERVAL_MS);
  expect(PI_CHAT_POLL_FIRST_INTERVAL_MS).toBeGreaterThanOrEqual(50);
  expect(PI_CHAT_POLL_FIRST_INTERVAL_MS).toBeLessThanOrEqual(100);
  expect(sleeps.slice(0, 3)).toEqual([50, 100, 200]);
  expect(Math.max(...sleeps)).toBeLessThanOrEqual(1_000);
});

test("a read that fails on the way is asked again", async () => {
  const { run } = harness([
    new Error("502"),
    { status: "pending" },
    { status: "ready", result: { sessions: [] } },
  ]);
  expect(await run()).toEqual({ sessions: [] });
});

test("a refusal to read is the same access denial a refused call was", async () => {
  const error = await rejection(harness([{ status: "pending" }, { status: "denied" }]).run());
  expect(isAppErrorCode(error, "ACCESS_DENIED")).toBe(true);
});

test("a failed command, an expired request and no answer by the deadline are the same unavailable error", async () => {
  for (const script of [[{ status: "failed" as const }], [{ status: "pending" as const }]]) {
    const error = await rejection(harness(script).run());
    expect(isAppErrorCode(error, "TEMPORARILY_UNAVAILABLE")).toBe(true);
  }
});

test("the client waits at least as long as the server did and stops before the reply expires", () => {
  expect(PI_CHAT_CLIENT_DEADLINE_MS).toBeGreaterThanOrEqual(25_000);
  expect(PI_CHAT_CLIENT_DEADLINE_MS).toBeLessThan(PI_CHAT_REPLY_TTL_SECONDS * 1_000);
});
