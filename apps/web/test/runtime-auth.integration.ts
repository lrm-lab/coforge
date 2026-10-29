import { afterAll, beforeEach, expect, test } from "bun:test";
import { RedisClient } from "bun";
import {
  decodeRuntimeAuthIntent,
  type RuntimeAuthIntent,
  type RuntimeAuthLoginReport,
  type RuntimeAuthLogoutReport,
} from "@lrm/coforge-sdk/internal";
import { RuntimeAuth } from "#src/server/computers/runtime-auth.server";
import {
  RUNTIME_AUTH_START_WINDOW_MS,
  RedisRuntimeAuthStore,
} from "#src/server/computers/runtime-auth-store.server";

const url = Bun.env.RUNTIME_AUTH_TEST_REDIS_URL;
if (!url) throw new Error("RUNTIME_AUTH_TEST_REDIS_URL must target a scratch Redis");

const redis = new RedisClient(url);
afterAll(() => redis.close());

const workspaceId = "workspace-1";
const alice = { userId: "alice", workspaceId };
const bob = { userId: "bob", workspaceId };
let computerId = "";
let published: { channel: string; bytes: Uint8Array }[] = [];
let clock = 1_000_000;
let ids = 0;
let online = true;
let capable = true;
let kiroCapable = true;
let statusReadCapable = true;
let allowed = new Set<string>();
let failIntents = false;

function service() {
  return new RuntimeAuth(
    { canManage: async (scope) => allowed.has(scope.userId) },
    new RedisRuntimeAuthStore(redis),
    {
      publish: async (channel, bytes) => {
        if (failIntents && channel.startsWith("daemon:")) throw new Error("down");
        published.push({ channel, bytes });
      },
    },
    { get: async () => online },
    {
      supports: async (_workspaceId, _computerId, provider) =>
        provider === "kiro" ? kiroCapable : capable,
      supportsStatusRead: async () => statusReadCapable,
    },
    () => `rtl_${String(++ids).padStart(20, "0")}`,
    () => clock,
  );
}

beforeEach(() => {
  computerId = `computer-${crypto.randomUUID()}`;
  published = [];
  clock = 1_000_000;
  ids = 0;
  online = true;
  capable = true;
  kiroCapable = true;
  statusReadCapable = true;
  allowed = new Set(["alice", "bob"]);
  failIntents = false;
});

const intents = (): RuntimeAuthIntent[] =>
  published
    .filter((p) => p.channel.startsWith("daemon:"))
    .map((p) => decodeRuntimeAuthIntent(p.bytes));
const signals = (userId: string) =>
  published
    .filter((p) => p.channel === `runtimeauth:user:${userId}`)
    .map((p) => JSON.parse(new TextDecoder().decode(p.bytes)));

const scope = () => ({ workspaceId, computerId });
const loginReport = (
  loginId: string,
  sequence: number,
  body:
    | { event: NonNullable<RuntimeAuthLoginReport["event"]> }
    | { result: NonNullable<RuntimeAuthLoginReport["result"]> },
): RuntimeAuthLoginReport =>
  ({
    protocolMajor: 1,
    workspaceId,
    computerId,
    loginId,
    sequence,
    ...body,
  }) as RuntimeAuthLoginReport;

test("starting a login publishes the intent and holds the provider", async () => {
  const auth = service();
  const started = await auth.startLogin(alice, { computerId, provider: "claude-code" });
  expect(started).toEqual({ status: "started", loginId: "rtl_00000000000000000001" });
  expect(intents()).toEqual([
    {
      protocolMajor: 1,
      workspaceId,
      computerId,
      kind: "login_start",
      loginId: "rtl_00000000000000000001",
      provider: "claude-code",
    },
  ]);
  expect(await auth.startLogin(bob, { computerId, provider: "claude-code" })).toEqual({
    status: "busy",
  });
  expect((await auth.startLogin(bob, { computerId, provider: "codex" })).status).toBe("started");
});

test("a person who may not manage the Computer, or a Computer that is away or old, starts nothing", async () => {
  allowed.delete("alice");
  await expect(service().startLogin(alice, { computerId, provider: "codex" })).rejects.toThrow(
    "not available",
  );
  allowed.add("alice");
  online = false;
  expect(await service().startLogin(alice, { computerId, provider: "codex" })).toEqual({
    status: "offline",
  });
  online = true;
  capable = false;
  expect(await service().startLogin(alice, { computerId, provider: "codex" })).toEqual({
    status: "needs_upgrade",
  });
  expect(published).toEqual([]);
});

test("a failed publish ends the login and frees the provider", async () => {
  const auth = service();
  failIntents = true;
  expect(await auth.startLogin(alice, { computerId, provider: "codex" })).toEqual({
    status: "offline",
  });
  failIntents = false;
  expect((await auth.startLogin(alice, { computerId, provider: "codex" })).status).toBe("started");
});

test("reports reach only the starter, in order, and the result frees the provider", async () => {
  const auth = service();
  const { loginId } = (await auth.startLogin(alice, { computerId, provider: "claude-code" })) as {
    loginId: string;
  };
  const event = { kind: "auth_url", url: "https://example.com/login" } as const;
  expect(await auth.receiveLoginReport(scope(), loginReport(loginId, 1, { event }))).toBe(true);
  const prompt = { kind: "code_prompt", message: "Paste the code" } as const;
  expect(await auth.receiveLoginReport(scope(), loginReport(loginId, 2, { event: prompt }))).toBe(
    true,
  );
  // A stale or repeated report is accepted and dropped.
  expect(
    await auth.receiveLoginReport(
      scope(),
      loginReport(loginId, 1, { event: { kind: "info", message: "old" } }),
    ),
  ).toBe(true);
  expect(signals("alice")).toHaveLength(2);
  expect(signals("alice")[0]).toMatchObject({
    type: "runtime-auth.login.v1",
    computerId,
    loginId,
    sequence: 1,
    event,
  });
  expect(signals("bob")).toEqual([]);
  expect(await auth.readLogin(bob, { computerId, loginId })).toBeUndefined();
  expect(await auth.readLogin(alice, { computerId, loginId })).toMatchObject({
    sequence: 2,
    authUrl: event,
    event: prompt,
  });

  await auth.receiveLoginReport(
    scope(),
    loginReport(loginId, 3, { result: { kind: "logged_in" } }),
  );
  // Nothing follows a result.
  await auth.receiveLoginReport(
    scope(),
    loginReport(loginId, 4, { result: { kind: "cancelled" } }),
  );
  expect(await auth.readLogin(alice, { computerId, loginId })).toMatchObject({
    sequence: 3,
    result: { kind: "logged_in" },
  });
  expect((await auth.startLogin(bob, { computerId, provider: "claude-code" })).status).toBe(
    "started",
  );
});

test("a report for a login this Computer does not hold is refused", async () => {
  const auth = service();
  const { loginId } = (await auth.startLogin(alice, { computerId, provider: "codex" })) as {
    loginId: string;
  };
  const report = loginReport(loginId, 1, { result: { kind: "busy" } });
  expect(
    await auth.receiveLoginReport(
      { workspaceId, computerId: "computer-other" },
      { ...report, computerId: "computer-other" },
    ),
  ).toBe(false);
  expect(await auth.receiveLoginReport(scope(), { ...report, computerId: "computer-other" })).toBe(
    false,
  );
  expect(
    await auth.receiveLoginReport(
      scope(),
      loginReport("rtl_unknownunknownunknown", 1, { result: { kind: "busy" } }),
    ),
  ).toBe(false);
  expect(await auth.readLogin(alice, { computerId, loginId })).toMatchObject({ sequence: 0 });
});

test("the code goes to the daemon once, from the starter only, and is not kept", async () => {
  const auth = service();
  const { loginId } = (await auth.startLogin(alice, { computerId, provider: "claude-code" })) as {
    loginId: string;
  };
  expect(await auth.submitCode(bob, { computerId, loginId, code: "abc" })).toBe("not_available");
  expect(await auth.submitCode(alice, { computerId, loginId, code: "  abc-123\n" })).toBe("sent");
  expect(await auth.submitCode(alice, { computerId, loginId, code: "\u0000" })).toBe(
    "invalid_code",
  );
  expect(intents().at(-1)).toMatchObject({ kind: "login_code", loginId, code: "abc-123" });
  const stored = await redis.send("KEYS", ["*" + computerId + "*"]);
  for (const key of stored as string[]) expect(await redis.get(key)).not.toContain("abc-123");
  await auth.receiveLoginReport(
    scope(),
    loginReport(loginId, 1, { result: { kind: "logged_in" } }),
  );
  expect(await auth.submitCode(alice, { computerId, loginId, code: "abc" })).toBe("not_available");
});

test("cancelling is the starter's, and only while the login is open", async () => {
  const auth = service();
  const { loginId } = (await auth.startLogin(alice, { computerId, provider: "codex" })) as {
    loginId: string;
  };
  expect(await auth.cancelLogin(bob, { computerId, loginId })).toBe("not_available");
  expect(await auth.cancelLogin(alice, { computerId, loginId })).toBe("sent");
  expect(intents().at(-1)).toMatchObject({ kind: "login_cancel", loginId });
});

test("a login nothing has answered in the start window fails and frees the provider", async () => {
  const auth = service();
  const { loginId } = (await auth.startLogin(alice, { computerId, provider: "codex" })) as {
    loginId: string;
  };
  clock += RUNTIME_AUTH_START_WINDOW_MS + 1;
  expect(await auth.readLogin(alice, { computerId, loginId })).toMatchObject({
    result: { kind: "failed", reason: "timed_out" },
  });
  expect((await auth.startLogin(bob, { computerId, provider: "codex" })).status).toBe("started");
});

test("a login the daemon has answered is not cut by the start window", async () => {
  const auth = service();
  const { loginId } = (await auth.startLogin(alice, { computerId, provider: "codex" })) as {
    loginId: string;
  };
  await auth.receiveLoginReport(
    scope(),
    loginReport(loginId, 1, { event: { kind: "info", message: "waiting" } }),
  );
  clock += RUNTIME_AUTH_START_WINDOW_MS + 1;
  expect((await auth.readLogin(alice, { computerId, loginId }))?.result).toBeUndefined();
  expect(await auth.startLogin(bob, { computerId, provider: "codex" })).toEqual({ status: "busy" });
});

test("a start window that passed frees the provider for a new login even if nobody read it", async () => {
  const auth = service();
  await auth.startLogin(alice, { computerId, provider: "codex" });
  clock += RUNTIME_AUTH_START_WINDOW_MS + 1;
  expect((await auth.startLogin(bob, { computerId, provider: "codex" })).status).toBe("started");
});

test("sign-out is idempotent per request id and reports back to its requester", async () => {
  const auth = service();
  const first = await auth.logout(alice, { computerId, provider: "codex", requestId: "request-1" });
  const again = await auth.logout(alice, { computerId, provider: "codex", requestId: "request-1" });
  expect(first).toEqual(again);
  expect(intents().filter((i) => i.kind === "logout")).toHaveLength(1);
  const report: RuntimeAuthLogoutReport = {
    protocolMajor: 1,
    workspaceId,
    computerId,
    requestId: "request-1",
    result: { kind: "logged_out" },
  };
  expect(await auth.receiveLogoutReport(scope(), report)).toBe(true);
  expect(signals("alice")[0]).toMatchObject({
    type: "runtime-auth.logout.v1",
    requestId: "request-1",
    result: { kind: "logged_out" },
  });
  expect(await auth.readLogout(alice, { computerId, requestId: "request-1" })).toMatchObject({
    result: { kind: "logged_out" },
  });
  await expect(auth.readLogout(bob, { computerId, requestId: "request-1" })).rejects.toThrow(
    "not available",
  );
  expect(await auth.receiveLogoutReport(scope(), { ...report, requestId: "request-unknown" })).toBe(
    false,
  );
});

test("a failed publish ends the sign-out", async () => {
  const auth = service();
  failIntents = true;
  expect(
    await auth.logout(alice, { computerId, provider: "codex", requestId: "request-2" }),
  ).toEqual({ status: "offline" });
  expect(await auth.readLogout(alice, { computerId, requestId: "request-2" })).toMatchObject({
    result: { kind: "failed", reason: "process_failed" },
  });
});

test("two logins started together for one provider: exactly one starts", async () => {
  for (let round = 0; round < 20; round++) {
    computerId = `computer-${crypto.randomUUID()}`;
    const results = await Promise.all([
      service().startLogin(alice, { computerId, provider: "codex" }),
      service().startLogin(bob, { computerId, provider: "codex" }),
      service().startLogin(alice, { computerId, provider: "codex" }),
    ]);
    expect(results.filter((r) => r.status === "started")).toHaveLength(1);
    expect(results.filter((r) => r.status === "busy")).toHaveLength(2);
  }
});

test("the provider's lock is the Computer's, across the Workspaces it is connected to", async () => {
  const auth = service();
  expect((await auth.startLogin(alice, { computerId, provider: "codex" })).status).toBe("started");
  const elsewhere = { userId: "alice", workspaceId: "workspace-2" };
  expect(await auth.startLogin(elsewhere, { computerId, provider: "codex" })).toEqual({
    status: "busy",
  });
});

test("a login still going keeps its lock for as long as its record", async () => {
  const auth = service();
  const { loginId } = (await auth.startLogin(alice, { computerId, provider: "codex" })) as {
    loginId: string;
  };
  const keys = (await redis.send("KEYS", [
    `coforge:computer:${computerId}:runtime-auth-lock:*`,
  ])) as string[];
  expect(keys).toHaveLength(1);
  await redis.send("EXPIRE", [keys[0]!, "30"]);
  await auth.receiveLoginReport(
    scope(),
    loginReport(loginId, 1, { event: { kind: "info", message: "waiting" } }),
  );
  expect(Number(await redis.send("TTL", [keys[0]!]))).toBeGreaterThan(600);
});

test("a result frees the lock even when an earlier release failed", async () => {
  const auth = service();
  const { loginId } = (await auth.startLogin(alice, { computerId, provider: "codex" })) as {
    loginId: string;
  };
  await auth.receiveLoginReport(
    scope(),
    loginReport(loginId, 1, { result: { kind: "cancelled" } }),
  );
  // Put the lock back as if its release had failed, then repeat the result: the repeat frees it.
  const [key] = (await redis.send("KEYS", [
    `coforge:computer:${computerId}:runtime-auth-lock:*`,
  ])) as string[];
  expect(key).toBeUndefined();
  await redis.set(
    `coforge:computer:${computerId}:runtime-auth-lock:v1:codex`,
    JSON.stringify({ workspaceId, loginId }),
  );
  await auth.receiveLoginReport(
    scope(),
    loginReport(loginId, 2, { result: { kind: "cancelled" } }),
  );
  expect(await redis.get(`coforge:computer:${computerId}:runtime-auth-lock:v1:codex`)).toBeNull();
});

test("Kiro enterprise target reaches only its intent, and old Computers cannot start it", async () => {
  const kiroIdentityCenter = { startUrl: "https://example.awsapps.com/start", region: "us-east-1" };
  const auth = service();
  kiroCapable = false;
  expect(
    await auth.startLogin(alice, { computerId, provider: "kiro", kiroIdentityCenter }),
  ).toEqual({ status: "needs_upgrade" });
  expect(intents()).toEqual([]);
  kiroCapable = true;
  expect(
    (await auth.startLogin(alice, { computerId, provider: "kiro", kiroIdentityCenter })).status,
  ).toBe("started");
  expect(intents()[0]).toMatchObject({ provider: "kiro", kiroIdentityCenter });
  const loginId =
    intents()[0]!.kind === "login_start"
      ? (intents()[0] as Extract<RuntimeAuthIntent, { kind: "login_start" }>).loginId
      : "";
  const view = await auth.readLogin(alice, { computerId, loginId });
  expect(view).not.toHaveProperty("kiroIdentityCenter");
});

test("a page opening a runtime asks for just that one to be read again", async () => {
  expect(await service().requestStatusRead(alice, { computerId, provider: "codex" })).toBe(
    "requested",
  );
  expect(intents()).toEqual([
    { ...scope(), protocolMajor: 1, kind: "status_read", provider: "codex" },
  ]);
  expect(published.filter((entry) => !entry.channel.startsWith("daemon:"))).toEqual([]);
});

test("a status read on a Computer that is away, old, or not the caller's asks for nothing", async () => {
  allowed.delete("alice");
  await expect(
    service().requestStatusRead(alice, { computerId, provider: "codex" }),
  ).rejects.toThrow("not available");
  allowed.add("alice");
  online = false;
  expect(await service().requestStatusRead(alice, { computerId, provider: "codex" })).toBe(
    "offline",
  );
  online = true;
  statusReadCapable = false;
  expect(await service().requestStatusRead(alice, { computerId, provider: "codex" })).toBe(
    "needs_upgrade",
  );
  statusReadCapable = true;
  failIntents = true;
  expect(await service().requestStatusRead(alice, { computerId, provider: "codex" })).toBe(
    "offline",
  );
  expect(intents()).toEqual([]);
});
