import { describe, expect, test } from "bun:test";
import { parseBridgeArgs, runBridge, type BridgeDeps } from "../src/external/bridge";
import { OLD_KEY, fakeFetch, json, profile, useAgentHome, type Handler } from "./external-fixture";

const home = useAgentHome();

const RUNTIME = "http://127.0.0.1:7777";
const event = (id: string, status = "working") => ({
  eventId: id,
  occurredAt: "2026-11-17T08:00:00.000Z",
  status,
});
const drained = (events: unknown[], dropped = 0) =>
  json({ schema: "coforge-activity-drain.v1", events, dropped });
const emptyStream = () =>
  new Response(new ReadableStream({ start: (c) => c.close() }), {
    headers: { "content-type": "text/event-stream" },
  });

function setup(handler: Handler, limit = 20) {
  const fake = fakeFetch(handler);
  const err: string[] = [];
  const controller = new AbortController();
  let sleeps = 0;
  const deps: BridgeDeps = {
    store: home.store,
    fetch: fake.fetch as never,
    stdout: () => {},
    stderr: (text) => err.push(text),
    sleep: async () => {
      sleeps += 1;
      if (sleeps > limit) controller.abort();
    },
    signal: controller.signal,
  };
  const forwarded = () =>
    fake.requests
      .filter((r) => r.method === "POST" && r.url.pathname === "/api/agent/v1/activity")
      .map((r) => JSON.parse(r.body) as { schema: string; events: { eventId: string }[] });
  return { fake, err, deps, forwarded };
}

describe("activity arguments", () => {
  test("the drain endpoint defaults to /activity/drain beside the wake endpoint", () => {
    const options = parseBridgeArgs(["--wake-endpoint", `${RUNTIME}/wake?x=1`], {});
    expect(options.activityEndpoint?.toString()).toBe(`${RUNTIME}/activity/drain`);
    expect(options.activityDrainLimit).toBe(50);
  });

  test("an explicit endpoint, limit and the channel token", () => {
    const options = parseBridgeArgs(
      ["--activity-endpoint", `${RUNTIME}/drain`, "--activity-drain-limit", "5"],
      { COFORGE_CHANNEL_TOKEN: "tok" },
    );
    expect(options.activityEndpoint?.toString()).toBe(`${RUNTIME}/drain`);
    expect(options.activityDrainLimit).toBe(5);
    expect(options.channelToken).toBe("tok");
  });

  test("no wake or activity endpoint means no draining", () => {
    expect(parseBridgeArgs([], {}).activityEndpoint).toBeUndefined();
  });

  test.each([
    [["--activity-endpoint", "http://example.com/drain"], "WAKE_ENDPOINT_NOT_LOOPBACK"],
    [["--activity-endpoint", "nope"], "INVALID_ARG"],
    [["--activity-drain-limit", "0"], "INVALID_ARG"],
  ])("%j is refused as %s", (args, code) => {
    expect(() => parseBridgeArgs(args, {})).toThrow(expect.objectContaining({ code }));
  });
});

describe("forwarding the runtime's activity", () => {
  test("--once drains once and forwards the events under the ingest schema", async () => {
    await home.store.writeProfile("p", profile());
    const { deps, fake, forwarded } = setup((request) => {
      if (request.url.origin === RUNTIME) return drained([event("e1"), event("e2", "online")]);
      if (request.method === "POST") return json({ acceptedCount: 2, rejectedCount: 0 });
      return emptyStream();
    });
    const code = await runBridge(
      parseBridgeArgs(["--once", "--activity-endpoint", `${RUNTIME}/activity/drain`], {
        COFORGE_CHANNEL_TOKEN: "tok",
      }),
      "p",
      deps,
    );
    expect(code).toBe(0);
    const drain = fake.requests.find((r) => r.url.origin === RUNTIME)!;
    expect(drain.method).toBe("GET");
    expect(drain.url.searchParams.get("max")).toBe("50");
    expect(drain.headers.get("x-coforge-bridge-token")).toBe("tok");
    expect(drain.headers.get("authorization")).toBeNull();
    const post = fake.requests.find((r) => r.method === "POST")!;
    expect(post.headers.get("authorization")).toBe(`Bearer ${OLD_KEY}`);
    expect(forwarded()).toEqual([
      {
        schema: "coforge-agent-activity-ingest.v1",
        events: [event("e1"), event("e2", "online")],
      },
    ]);
  });

  test("an empty drain forwards nothing", async () => {
    await home.store.writeProfile("p", profile());
    const { deps, forwarded } = setup((request) =>
      request.url.origin === RUNTIME ? drained([]) : emptyStream(),
    );
    await runBridge(
      parseBridgeArgs(["--once", "--activity-endpoint", `${RUNTIME}/d`], {}),
      "p",
      deps,
    );
    expect(forwarded()).toEqual([]);
  });

  test("a batch the server could not take is sent again before newer events", async () => {
    await home.store.writeProfile("p", profile());
    let drains = 0;
    let posts = 0;
    const { deps, forwarded } = setup((request) => {
      if (request.url.origin === RUNTIME) {
        drains += 1;
        return drained(drains === 1 ? [event("e1")] : drains === 2 ? [event("e2")] : []);
      }
      if (request.method === "POST") {
        posts += 1;
        return posts === 1 ? json({ error: "down" }, 503) : json({ acceptedCount: 1 });
      }
      return emptyStream();
    });
    await runBridge(parseBridgeArgs(["--activity-endpoint", `${RUNTIME}/d`], {}), "p", deps);
    const ids = forwarded().map((body) => body.events.map((e) => e.eventId));
    expect(ids[0]).toEqual(["e1"]);
    expect(ids[1]).toEqual(["e1", "e2"]);
  });

  test("a batch the server refuses as invalid is dropped and reported", async () => {
    await home.store.writeProfile("p", profile());
    let drains = 0;
    const { deps, err, forwarded } = setup((request) => {
      if (request.url.origin === RUNTIME) {
        drains += 1;
        return drained(drains === 1 ? [event("bad", "dancing")] : [event("ok")]);
      }
      if (request.method === "POST") {
        const body = JSON.parse(request.body) as { events: { eventId: string }[] };
        return body.events.some((e) => e.eventId === "bad")
          ? json({ code: "status_invalid" }, 400)
          : json({ acceptedCount: 1 });
      }
      return emptyStream();
    }, 6);
    await runBridge(parseBridgeArgs(["--activity-endpoint", `${RUNTIME}/d`], {}), "p", deps);
    expect(forwarded()[1]!.events.map((e) => e.eventId)).toEqual(["ok"]);
    expect(err.join("")).toContain("status_invalid");
  });

  test("a drain answer in another shape forwards nothing", async () => {
    await home.store.writeProfile("p", profile());
    const { deps, err, forwarded } = setup((request) =>
      request.url.origin === RUNTIME ? json({ events: [event("e1")] }) : emptyStream(),
    );
    await runBridge(
      parseBridgeArgs(["--once", "--activity-endpoint", `${RUNTIME}/d`], {}),
      "p",
      deps,
    );
    expect(forwarded()).toEqual([]);
    expect(err.join("")).toContain("coforge-activity-drain.v1");
  });

  test("a revoked key stops the bridge", async () => {
    await home.store.writeProfile("p", profile());
    const { deps } = setup((request) => {
      if (request.url.origin === RUNTIME) return drained([event("e1")]);
      if (request.method === "POST") return json({ code: "invalid_credential" }, 401);
      return new Response(new ReadableStream(), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    await expect(
      runBridge(parseBridgeArgs(["--activity-endpoint", `${RUNTIME}/d`], {}), "p", deps),
    ).rejects.toMatchObject({ code: "EXTERNAL_CREDENTIAL_INVALID" });
  });
});
