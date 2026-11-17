import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { RedisClient } from "bun";
import { RedisAgentDisplay } from "#src/server/agents/agent-display.server";
import { EXTERNAL_ONLINE_WINDOW_MS } from "#src/server/agents/external-agent-presence.server";

const redisServer = Bun.which("redis-server");
if (!redisServer) throw new Error("redis-server is required for the external display suite");
const port = 20_000 + Math.floor(Math.random() * 20_000);
let server: ReturnType<typeof Bun.spawn> | undefined;
let redis: RedisClient;
let now = 1_000_000_000;

const WINDOW = EXTERNAL_ONLINE_WINDOW_MS;
const scope = { workspaceId: "workspace-a", computerId: "", agentId: "agent-a" };

const display = () => new RedisAgentDisplay(redis, () => now);
const presence = (subject: RedisAgentDisplay, seenAtMs: number) =>
  subject.observeExternalPresence(scope, { seenAtMs, windowMs: WINDOW });
const status = (
  subject: RedisAgentDisplay,
  kind: "online" | "thinking" | "working" | "error" | "offline",
  occurredAtMs: number,
  detail = "",
  reported = true,
) =>
  subject.observeExternalStatus(scope, { kind, detail, occurredAtMs, reported, windowMs: WINDOW });

beforeAll(async () => {
  server = Bun.spawn([redisServer, "--port", String(port), "--save", "", "--appendonly", "no"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  redis = new RedisClient(`redis://127.0.0.1:${port}`);
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await redis.send("PING", []);
      return;
    } catch {
      await Bun.sleep(10);
    }
  }
  throw new Error("isolated redis-server did not become ready");
});

afterAll(async () => {
  redis?.close();
  server?.kill();
  await server?.exited;
});

describe("external Agent display", () => {
  test("first seen shows online until the window ends, and a renewal publishes nothing", async () => {
    await redis.send("FLUSHDB", []);
    const subject = display();
    expect((await subject.snapshot(scope)).activityKind).toBe("offline");
    const first = await presence(subject, now);
    expect(first?.activityKind).toBe("online");
    expect(first?.expiresAt).toBe(now + WINDOW);
    now += 30_000;
    expect(await presence(subject, now)).toBeUndefined();
    const renewed = await subject.snapshot(scope);
    expect(renewed.activityKind).toBe("online");
    expect(renewed.expiresAt).toBe(now + WINDOW);
    now += WINDOW + 1;
    const lapsed = await subject.snapshot(scope);
    expect(lapsed.activityKind).toBe("offline");
    expect(lapsed.revision).toBeGreaterThan(renewed.revision);
  });

  test("a revoked last credential shows offline at once; another live one keeps it online", async () => {
    await redis.send("FLUSHDB", []);
    const subject = display();
    await presence(subject, now);
    const kept = await presence(subject, now - 10_000);
    expect(kept).toBeUndefined();
    expect((await subject.snapshot(scope)).activityKind).toBe("online");
    const revoked = await presence(subject, 0);
    expect(revoked?.activityKind).toBe("offline");
    expect(revoked?.expiresAt).toBeNull();
    expect(await presence(subject, 0)).toBeUndefined();
  });

  test("a reported status shows, with detail, and the newest report wins by occurredAt", async () => {
    await redis.send("FLUSHDB", []);
    const subject = display();
    await presence(subject, now);
    const working = await status(subject, "working", now - 1_000, "running tests");
    expect(working?.activityKind).toBe("working");
    expect(working?.detail).toBe("running tests");
    expect(await status(subject, "error", now - 5_000, "late")).toBeUndefined();
    expect((await subject.snapshot(scope)).activityKind).toBe("working");
    expect(await status(subject, "working", now - 1_000, "same time")).toBeUndefined();
    const error = await status(subject, "error", now, "needs a key");
    expect(error?.activityKind).toBe("error");
    expect(error?.stopReason ?? null).toBeNull();
    const idle = await status(subject, "online", now + 1);
    expect(idle?.activityKind).toBe("online");
    expect(idle?.detail).toBe("");
  });

  test("presence renewals keep a reported status; the window lapsing drops it", async () => {
    await redis.send("FLUSHDB", []);
    const subject = display();
    await presence(subject, now);
    await status(subject, "thinking", now);
    now += 60_000;
    expect(await presence(subject, now)).toBeUndefined();
    expect((await subject.snapshot(scope)).activityKind).toBe("thinking");
    now += WINDOW + 1;
    expect((await subject.snapshot(scope)).activityKind).toBe("offline");
    const back = await presence(subject, now);
    expect(back?.activityKind).toBe("online");
  });

  test("a reported offline stands against later presence until a newer report", async () => {
    await redis.send("FLUSHDB", []);
    const subject = display();
    await presence(subject, now);
    const offline = await status(subject, "offline", now);
    expect(offline?.activityKind).toBe("offline");
    now += 30_000;
    expect(await presence(subject, now)).toBeUndefined();
    expect((await subject.snapshot(scope)).activityKind).toBe("offline");
    const back = await status(subject, "online", now);
    expect(back?.activityKind).toBe("online");
    expect(back?.expiresAt).toBe(now + WINDOW);
  });

  test("a hook guess moves the dot only before any status is reported", async () => {
    await redis.send("FLUSHDB", []);
    const subject = display();
    await presence(subject, now);
    expect((await status(subject, "working", now, "", false))?.activityKind).toBe("working");
    expect((await status(subject, "online", now + 1, "", false))?.activityKind).toBe("online");
    expect(await status(subject, "working", now, "", false)).toBeUndefined();
    await status(subject, "thinking", now - 500);
    expect(await status(subject, "working", now + 10, "", false)).toBeUndefined();
    expect((await subject.snapshot(scope)).activityKind).toBe("thinking");
  });
  test("a seen captured before the offline sync cannot relight the dot; a later one can", async () => {
    await redis.send("FLUSHDB", []);
    const subject = display();
    const touchedAt = now;
    await presence(subject, touchedAt);
    now += 1_000;
    expect((await presence(subject, 0))?.activityKind).toBe("offline");
    now += 500;
    expect(await presence(subject, touchedAt)).toBeUndefined();
    expect((await subject.snapshot(scope)).activityKind).toBe("offline");
    const next = await presence(subject, now);
    expect(next?.activityKind).toBe("online");
    expect(next?.expiresAt).toBe(now + WINDOW);
  });

  test("an older seen never shortens the lease", async () => {
    await redis.send("FLUSHDB", []);
    const subject = display();
    await presence(subject, now);
    expect(await presence(subject, now - 60_000)).toBeUndefined();
    const held = await subject.snapshot(scope);
    expect(held.activityKind).toBe("online");
    expect(held.expiresAt).toBe(now + WINDOW);
  });
});
