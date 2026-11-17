import { afterEach, describe, expect, test } from "bun:test";
import type { WakeHint } from "@lrm/coforge-sdk/agent";
import { parseBridgeArgs, runBridge, type BridgeDeps } from "../src/external/bridge";
import {
  SERVER,
  OLD_KEY,
  fakeFetch,
  json,
  profile,
  useAgentHome,
  type Handler,
} from "./external-fixture";

const home = useAgentHome();

const hint = (seq: number, over: Partial<WakeHint> = {}): WakeHint => ({
  target: "#general",
  channelId: "c1",
  channelType: "channel",
  pendingCount: seq,
  firstPendingMsgId: "m1",
  latestMsgId: `m${seq}`,
  latestSeq: String(seq),
  latestSenderName: "ada",
  latestSenderType: "human",
  flags: ["mention"],
  ...over,
});

const frame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function sse(frames: string[], keepOpen = false): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const text of frames) controller.enqueue(encoder.encode(text));
        if (!keepOpen) controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function setup(handler: Handler, over: Partial<BridgeDeps> = {}) {
  const fake = fakeFetch(handler);
  const out: string[] = [];
  const err: string[] = [];
  const sleeps: number[] = [];
  const controller = new AbortController();
  const deps: BridgeDeps = {
    store: home.store,
    fetch: fake.fetch as never,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    sleep: async (ms) => {
      sleeps.push(ms);
      if (sleeps.length > 20) controller.abort();
    },
    signal: controller.signal,
    ...over,
  };
  return { fake, out, err, sleeps, deps, controller };
}

const lines = (out: string[]) => out.join("").split("\n").filter(Boolean);

describe("bridge arguments", () => {
  test("defaults and every flag", () => {
    expect(parseBridgeArgs([], {})).toMatchObject({
      json: false,
      once: false,
      pollIntervalMs: 15_000,
    });
    expect(
      parseBridgeArgs(
        [
          "--json",
          "--once",
          "--expected-agent",
          "a1",
          "--wake-endpoint",
          "http://127.0.0.1:9/wake",
          "--poll-interval-ms",
          "500",
        ],
        {},
      ),
    ).toMatchObject({ json: true, once: true, expectedAgent: "a1", pollIntervalMs: 500 });
    expect(parseBridgeArgs([], { COFORGE_EXPECTED_AGENT_ID: "envagent" }).expectedAgent).toBe(
      "envagent",
    );
  });

  test.each([
    [["--wake-endpoint", "http://example.com/wake"], "WAKE_ENDPOINT_NOT_LOOPBACK"],
    [["--wake-endpoint", "https://10.0.0.5/wake"], "WAKE_ENDPOINT_NOT_LOOPBACK"],
    [["--wake-endpoint", "ftp://127.0.0.1/x"], "INVALID_ARG"],
    [["--wake-endpoint", "not a url"], "INVALID_ARG"],
    [["--poll-interval-ms", "0"], "INVALID_ARG"],
    [["--poll-interval-ms", "abc"], "INVALID_ARG"],
    [["--nope"], "INVALID_ARG"],
  ])("%j is refused as %s", (args, code) => {
    expect(() => parseBridgeArgs(args, {})).toThrow(expect.objectContaining({ code }));
  });

  test("loopback hosts are accepted", () => {
    for (const host of ["127.0.0.1", "localhost", "[::1]", "127.0.0.9"])
      expect(
        parseBridgeArgs(["--wake-endpoint", `http://${host}:8080/x`], {}).wakeEndpoint,
      ).toBeDefined();
  });
});

describe("an external profile and the expected Agent", () => {
  test("a missing profile is refused", async () => {
    const { deps } = setup(() => json({}));
    await expect(runBridge(parseBridgeArgs(["--once"], {}), "none", deps)).rejects.toMatchObject({
      code: "PROFILE_NOT_LOGGED_IN",
    });
  });

  test("a profile bound to another Agent does nothing at all", async () => {
    await home.store.writeProfile("p", profile());
    const { deps, fake } = setup(() => json({}));
    await expect(
      runBridge(parseBridgeArgs(["--once", "--expected-agent", "someone-else"], {}), "p", deps),
    ).rejects.toMatchObject({ code: "AGENT_MISMATCH" });
    expect(fake.requests).toEqual([]);
  });
});

describe("one receive iteration", () => {
  test("--once --json prints each current hint as one NDJSON line and exits", async () => {
    await home.store.writeProfile("p", profile());
    const { deps, fake, out } = setup(() =>
      sse(
        [frame("hints", { hints: [hint(2), hint(3, { channelId: "c2", target: "@bob" })] })],
        true,
      ),
    );
    const code = await runBridge(parseBridgeArgs(["--once", "--json"], {}), "p", deps);
    expect(code).toBe(0);
    expect(lines(out).map((line) => JSON.parse(line))).toEqual([
      hint(2),
      hint(3, { channelId: "c2", target: "@bob" }),
    ]);
    expect(fake.requests[0]!.url.pathname).toBe("/api/agent/v1/wake-hints/stream");
    expect(fake.requests[0]!.headers.get("authorization")).toBe(`Bearer ${OLD_KEY}`);
  });

  test("the human form is one line per hint and never has a body", async () => {
    await home.store.writeProfile("p", profile());
    const { deps, out } = setup(() => sse([frame("hints", { hints: [hint(2)] })], true));
    await runBridge(parseBridgeArgs(["--once"], {}), "p", deps);
    expect(lines(out)).toEqual(["#general: 2 unread (mention), latest from ada"]);
  });

  test("falls back to polling when the stream is unavailable", async () => {
    await home.store.writeProfile("p", profile());
    const { deps, fake, out } = setup((request) =>
      request.url.pathname.endsWith("/stream")
        ? json({ error: "x" }, 503)
        : json({ hints: [hint(4)] }),
    );
    await runBridge(parseBridgeArgs(["--once", "--json"], {}), "p", deps);
    expect(fake.requests.map((r) => r.url.pathname)).toEqual([
      "/api/agent/v1/wake-hints/stream",
      "/api/agent/v1/wake-hints",
    ]);
    expect(lines(out)).toHaveLength(1);
  });

  test("never reads or acknowledges messages", async () => {
    await home.store.writeProfile("p", profile());
    const { deps, fake } = setup(() => sse([frame("hints", { hints: [hint(2)] })], true));
    await runBridge(parseBridgeArgs(["--once"], {}), "p", deps);
    for (const request of fake.requests) {
      expect(request.method).toBe("GET");
      expect(request.url.pathname).not.toContain("/events");
      expect(request.url.search).toBe("");
    }
  });

  test("a revoked key stops with a non-retryable error", async () => {
    await home.store.writeProfile("p", profile());
    const { deps } = setup(() => json({ code: "invalid_credential" }, 401));
    await expect(runBridge(parseBridgeArgs(["--once"], {}), "p", deps)).rejects.toMatchObject({
      code: "EXTERNAL_CREDENTIAL_INVALID",
    });
  });
});

describe("holding the stream", () => {
  test("emits a hint event once, ignores heartbeats and repeats of the same sequence", async () => {
    await home.store.writeProfile("p", profile());
    const { deps, out, controller } = setup(() => {
      queueMicrotask(() => setTimeout(() => controller.abort(), 20));
      return sse(
        [
          frame("hints", { hints: [hint(2)] }),
          frame("heartbeat", { at: "x" }),
          frame("hint", hint(2)),
          frame("hint", hint(5)),
        ],
        true,
      );
    });
    await runBridge(parseBridgeArgs(["--json"], {}), "p", deps);
    expect(lines(out).map((line) => (JSON.parse(line) as WakeHint).latestSeq)).toEqual(["2", "5"]);
  });

  test("reconnects with capped exponential backoff and polls while the stream is down", async () => {
    await home.store.writeProfile("p", profile());
    let polls = 0;
    const { deps, sleeps, fake, out, controller } = setup((request) => {
      if (request.url.pathname.endsWith("/stream")) return json({}, 503);
      polls++;
      if (polls === 3) controller.abort();
      return json({ hints: [hint(polls)] });
    });
    await runBridge(parseBridgeArgs(["--json", "--poll-interval-ms", "250"], {}), "p", deps);
    const streams = fake.requests.filter((r) => r.url.pathname.endsWith("/stream"));
    expect(streams.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(30_000);
    expect(lines(out).map((line) => (JSON.parse(line) as WakeHint).latestSeq)).toEqual([
      "1",
      "2",
      "3",
    ]);
  });
});

describe("--wake-endpoint", () => {
  test("posts each hint as JSON to the local endpoint instead of printing it", async () => {
    await home.store.writeProfile("p", profile());
    const posts: { url: string; body: unknown }[] = [];
    const { deps, out } = setup((request) => {
      if (request.url.origin === SERVER) return sse([frame("hints", { hints: [hint(2)] })], true);
      posts.push({ url: request.url.href, body: JSON.parse(request.body) });
      return new Response(null, { status: 204 });
    });
    await runBridge(
      parseBridgeArgs(["--once", "--wake-endpoint", "http://127.0.0.1:7777/wake"], {}),
      "p",
      deps,
    );
    expect(posts).toEqual([{ url: "http://127.0.0.1:7777/wake", body: hint(2) }]);
    expect(out).toEqual([]);
  });

  test("a failing endpoint is retried on the next receive rather than dropping the hint", async () => {
    await home.store.writeProfile("p", profile());
    let attempts = 0;
    const { deps, controller } = setup((request) => {
      if (request.url.origin === SERVER) return sse([frame("hints", { hints: [hint(2)] })]);
      attempts++;
      if (attempts >= 2) controller.abort();
      return new Response(null, { status: attempts === 1 ? 500 : 204 });
    });
    await runBridge(
      parseBridgeArgs(["--wake-endpoint", "http://127.0.0.1:7777/wake"], {}),
      "p",
      deps,
    );
    expect(attempts).toBe(2);
  });
});

describe("one bridge per profile", () => {
  test("a second bridge on the same profile is refused while the first holds the lock", async () => {
    await home.store.writeProfile("p", profile());
    const first = setup(() => sse([frame("hints", { hints: [] })], true));
    const running = runBridge(parseBridgeArgs([], {}), "p", first.deps);
    const second = setup(() => json({ hints: [] }));
    await Bun.sleep(50);
    await expect(
      runBridge(parseBridgeArgs(["--once"], {}), "p", second.deps),
    ).rejects.toMatchObject({
      code: "BRIDGE_ALREADY_RUNNING",
    });
    first.controller.abort();
    await running;
    await runBridge(parseBridgeArgs(["--once"], {}), "p", setup(() => json({ hints: [] })).deps);
  });

  test("a lock left by a dead process is replaced", async () => {
    await home.store.writeProfile("p", profile());
    await Bun.write(`${home.store.pathOf("p")}/bridge.lock`, "2147483646\n");
    const { deps } = setup(() => sse([frame("hints", { hints: [] })], true));
    expect(await runBridge(parseBridgeArgs(["--once"], {}), "p", deps)).toBe(0);
  });
});

test("bridge is an agent subcommand", async () => {
  const { isAgentSubcommand } = await import("../src/external/agent-cli");
  expect(isAgentSubcommand(["agent", "bridge"])).toBe(true);
});
