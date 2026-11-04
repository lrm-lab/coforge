import { afterEach, expect, test } from "bun:test";
import { readLatestComputerVersion } from "#src/server/computers/latest-computer-version.server";

/** The version cache is a module global, so every case drives it through the exported seam with
 * an explicitly injected clock. The clock only ever moves forward (the cache keys on `now - at`),
 * and afterEach jumps it far past every TTL and re-stamps it with a miss: every later test then
 * starts from a fetch, never from a previous test's cached answer. */
let nowMs = 1_000_000;
const now = () => nowMs;

function fakeFetch(
  response: { ok: true; body: string } | { ok: false; body: string } | "network-error",
  calls: string[],
) {
  return (async (input: unknown) => {
    calls.push(String(input));
    if (response === "network-error") throw new Error("feed down");
    return new Response(response.body, { status: response.ok ? 200 : 503 });
  }) as unknown as typeof fetch;
}

afterEach(async () => {
  // Jump the shared clock past every TTL and stamp the cache as an expired miss, so every
  // later test starts from a fetch rather than a previous test's cached answer.
  nowMs += 10_000_000;
  await readLatestComputerVersion("https://reset.test", fakeFetch("network-error", []), now);
  // The reset's read returns the stale value immediately; the refresh it started lands here.
  await Bun.sleep(0);
});

test("first read fetches the feed, later reads within the TTL reuse the answer", async () => {
  const calls: string[] = [];
  const fetchImpl = fakeFetch({ ok: true, body: "1.2.3\n" }, calls);
  expect(await readLatestComputerVersion("https://feed.test", fetchImpl, now)).toBe("1.2.3");
  expect(calls).toHaveLength(1);
  expect(await readLatestComputerVersion("https://feed.test", fetchImpl, now)).toBe("1.2.3");
  expect(calls).toHaveLength(1);
  // Past the TTL the next read answers the stale value while a refresh runs behind it; the
  // read after that sees the new release. A heartbeat never waits on the feed.
  nowMs += 60_000 + 1;
  const next = fakeFetch({ ok: true, body: "1.3.0\n" }, calls);
  expect(await readLatestComputerVersion("https://feed.test", next, now)).toBe("1.2.3");
  expect(calls).toHaveLength(2);
  await Bun.sleep(0);
  nowMs += 1;
  expect(await readLatestComputerVersion("https://feed.test", next, now)).toBe("1.3.0");
});

test("a failed feed read is cached only briefly, so the next window retries", async () => {
  const fetchImpl = fakeFetch({ ok: false, body: "" }, []);
  expect(await readLatestComputerVersion("https://feed.test", fetchImpl, now)).toBeNull();
  expect(await readLatestComputerVersion("https://feed.test", fetchImpl, now)).toBeNull();
  // The failure window is short: one second past it, the read retries (and may succeed).
  nowMs += 10_000 + 1;
  const recovered = fakeFetch({ ok: true, body: "2.0.0\n" }, []);
  expect(await readLatestComputerVersion("https://feed.test", recovered, now)).toBe("2.0.0");
});

test("an unparsable body is a miss, not a bad version", async () => {
  const fetchImpl = fakeFetch({ ok: true, body: "not a version\n" }, []);
  expect(await readLatestComputerVersion("https://feed.test", fetchImpl, now)).toBeNull();
  // Within the failure window the miss is reused, not re-fetched.
  expect(await readLatestComputerVersion("https://feed.test", fetchImpl, now)).toBeNull();
});

test("an expired value answers stale while the background refresh runs — no caller waits", async () => {
  nowMs += 10_001; // past the reset's miss TTL — the seed read actually fetches.
  const calls: string[] = [];
  const first = fakeFetch({ ok: true, body: "1.2.3\n" }, calls);
  expect(await readLatestComputerVersion("https://feed.test", first, now)).toBe("1.2.3");
  nowMs += 60_000 + 1;
  // A slow feed behind an expired cache: the read resolves the stale value without waiting.
  let resolveFetch!: (v: Response) => void;
  const slow = (async () => {
    calls.push("slow");
    return await new Promise<Response>((r) => {
      resolveFetch = r;
    });
  }) as unknown as typeof fetch;
  expect(await readLatestComputerVersion("https://feed.test", slow, now)).toBe("1.2.3");
  expect(calls).toHaveLength(2);
  // The refresh is still in flight; finishing it updates the cache for the next read.
  resolveFetch(new Response("1.3.0\n"));
  await Bun.sleep(0);
  nowMs += 1;
  expect(await readLatestComputerVersion("https://feed.test", slow, now)).toBe("1.3.0");
});

test("concurrent first reads share one in-flight fetch", async () => {
  const calls: string[] = [];
  let resolveFetch!: (v: Response) => void;
  const slow = (async () => {
    calls.push("slow");
    return await new Promise<Response>((r) => {
      resolveFetch = r;
    });
  }) as unknown as typeof fetch;
  nowMs += 10_001; // past the failure TTL the afterEach stamped — nothing left to serve.
  const a = readLatestComputerVersion("https://feed.test", slow, now);
  const b = readLatestComputerVersion("https://feed.test", slow, now);
  resolveFetch(new Response("1.2.3\n"));
  expect(await a).toBe("1.2.3");
  expect(await b).toBe("1.2.3");
  expect(calls).toHaveLength(1);
});
