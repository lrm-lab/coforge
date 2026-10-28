import { expect, test } from "bun:test";

import { deadlineSignal, readDeadline } from "#src/lib/read-deadline";

const timedOut = (reason: unknown) =>
  reason instanceof DOMException && reason.name === "TimeoutError";

test("a deadline aborts with a TimeoutError", async () => {
  const signal = deadlineSignal(10);
  await new Promise((resolve) => signal.addEventListener("abort", resolve));
  expect(timedOut(signal.reason)).toBe(true);
});

test("the caller's cancel still aborts, with its own reason", () => {
  const caller = new AbortController();
  const signal = deadlineSignal(60_000, caller.signal);
  caller.abort("left the page");
  expect(signal.reason).toBe("left the page");
});

test("an already cancelled caller aborts at once", () => {
  const caller = new AbortController();
  caller.abort("gone");
  expect(deadlineSignal(60_000, caller.signal).aborted).toBe(true);
});

type ClientMiddleware = (options: {
  method: "GET" | "POST";
  next: (ctx?: { fetch?: typeof fetch }) => unknown;
}) => unknown;

const clientOf = (middleware: ReturnType<typeof readDeadline>) =>
  (middleware as unknown as { options: { client: ClientMiddleware } }).options.client;

test("a read gets a fetch with the deadline; a write is left as it is", async () => {
  const client = clientOf(readDeadline(10));
  const passed: ({ fetch?: typeof fetch } | undefined)[] = [];
  const next = (ctx?: { fetch?: typeof fetch }) => passed.push(ctx);

  client({ method: "POST", next });
  client({ method: "GET", next });

  expect(passed[0]?.fetch).toBeUndefined();
  const realFetch = globalThis.fetch;
  let seen: AbortSignal | undefined;
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    seen = init?.signal ?? undefined;
    return new Promise<Response>(() => {});
  }) as typeof fetch;
  try {
    void passed[1]!.fetch!("/_serverFn/read", { method: "GET" });
  } finally {
    globalThis.fetch = realFetch;
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(timedOut(seen?.reason)).toBe(true);
});
