import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseAgentLoginArgs, runAgentLogin, type LoginDeps } from "../src/external/login";
import {
  DEVICE_CODE,
  NEW_KEY,
  OLD_KEY,
  SERVER,
  fakeFetch,
  json,
  profile,
  useAgentHome,
  type Handler,
} from "./external-fixture";

const home = useAgentHome();

const START = Date.parse("2026-11-16T00:00:00.000Z");
const granted = {
  device_code: DEVICE_CODE,
  user_code: "ABCD-EFGH",
  verification_uri: `${SERVER}/device`,
  expires_in: 600,
  interval: 5,
};
const issued = {
  kind: "external_agent",
  credential_id: "c2",
  api_key: NEW_KEY,
  agent_id: "a1",
  agent_name: "builder",
  workspace_id: "w1",
  workspace_slug: "acme",
};

let pastedKey = NEW_KEY;

function setup(handler: Handler) {
  const fake = fakeFetch(handler);
  const out: string[] = [];
  const sleeps: number[] = [];
  let clock = START;
  const deps: LoginDeps = {
    store: home.store,
    fetch: fake.fetch as LoginDeps["fetch"],
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    stdout: (text) => void out.push(text),
    machine: {
      machineName: "laptop",
      hostname: "laptop.local",
      os: "darwin 25",
      clientName: "coforge-cli test",
    },
    readKey: async () => pastedKey,
  };
  return { deps, out, sleeps, requests: fake.requests, text: () => out.join("") };
}

const login = parseAgentLoginArgs([
  "start",
  "--server",
  SERVER,
  "--workspace",
  "acme",
  "--agent",
  "@builder",
]);

const waiting = parseAgentLoginArgs(["wait"]);

async function signIn(deps: LoginDeps) {
  await runAgentLogin(login, undefined, deps);
  await runAgentLogin(waiting, undefined, deps);
}

/** Answers the device endpoint, then the token endpoint with `polls` in order. */
function grantThen(polls: Response[], other: Handler = () => json({}, 404)): Handler {
  const queue = [...polls];
  return (request) => {
    if (request.url.pathname === "/oauth/device") return json(granted);
    if (request.url.pathname === "/oauth/token")
      return queue.shift() ?? json({ error: "authorization_pending" }, 400);
    return other(request);
  };
}

const pending = () => json({ error: "authorization_pending" }, 400);

test("login prints the link and user code, waits through pending, and saves the key", async () => {
  const s = setup(grantThen([pending(), json(issued)]));
  await signIn(s.deps);
  expect(s.text()).toContain(`Open: ${SERVER}/device`);
  expect(s.text()).toContain("Code: ABCD-EFGH");
  expect(s.text()).toContain("state: authorized");
  expect(s.text()).toContain("coforge --profile acme-builder");
  expect(s.sleeps).toEqual([5000, 5000]);
  const saved = await home.store.readProfile("acme-builder");
  expect(saved).toMatchObject({
    apiKey: NEW_KEY,
    agentId: "a1",
    credentialId: "c2",
    serverUrl: SERVER,
  });
  expect(await home.store.readPending("acme-builder")).toBeUndefined();
});

test("the device grant request names no Workspace or Agent, only the machine, and never the key", async () => {
  const s = setup(grantThen([json(issued)]));
  await signIn(s.deps);
  const device = new URLSearchParams(s.requests[0]!.body);
  expect(Object.fromEntries(device)).toEqual({
    client_id: "coforge-cli",
    machine_name: "laptop",
    hostname: "laptop.local",
    os: "darwin 25",
    client_name: "coforge-cli test",
  });
  const token = new URLSearchParams(s.requests[1]!.body);
  expect(token.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
  expect(token.get("device_code")).toBe(DEVICE_CODE);
});

test("the device code and the key are never printed", async () => {
  const s = setup(grantThen([json(issued)]));
  await signIn(s.deps);
  expect(s.text()).not.toContain(DEVICE_CODE);
  expect(s.text()).not.toContain(NEW_KEY);
});

test("slow_down adds five seconds to the polling interval", async () => {
  const s = setup(grantThen([json({ error: "slow_down" }, 400), pending(), json(issued)]));
  await signIn(s.deps);
  expect(s.sleeps).toEqual([5000, 10_000, 10_000]);
});

test("a code that is never approved expires and removes the pending sign-in", async () => {
  const s = setup(grantThen([]));
  await expect(signIn(s.deps)).rejects.toMatchObject({
    code: "DEVICE_CODE_EXPIRED",
  });
  expect(await home.store.readPending("acme-builder")).toBeUndefined();
  expect(await home.store.readProfile("acme-builder")).toBeUndefined();
});

test("expired_token from the server tells the person to run login again", async () => {
  const s = setup(grantThen([json({ error: "expired_token" }, 400)]));
  await expect(signIn(s.deps)).rejects.toMatchObject({
    code: "DEVICE_CODE_EXPIRED",
    suggestedNextAction: expect.stringContaining("coforge agent login"),
  });
});

test.each([
  ["not_authorized", "LOGIN_DENIED", "owner or admin"],
  ["agent_not_external", "LOGIN_DENIED", "managed by a Computer"],
  ["agent_unavailable", "LOGIN_DENIED", "stopped or deleted"],
  ["credential_limit", "LOGIN_DENIED", "most machine keys"],
  ["agent_not_found", "AGENT_NOT_FOUND", "no longer exists"],
])("access_denied %s is explained", async (coforgeCode, code, words) => {
  const s = setup(grantThen([json({ error: "access_denied", coforge_code: coforgeCode }, 400)]));
  await expect(signIn(s.deps)).rejects.toMatchObject({
    code,
    message: expect.stringContaining(words),
  });
});

test("a plain access_denied is a denial and invalid_grant a stale code", async () => {
  const denied = setup(grantThen([json({ error: "access_denied" }, 400)]));
  await expect(signIn(denied.deps)).rejects.toMatchObject({
    code: "LOGIN_DENIED",
  });
  const stale = setup(grantThen([json({ error: "invalid_grant" }, 400)]));
  await expect(signIn(stale.deps)).rejects.toMatchObject({
    code: "DEVICE_CODE_INVALID",
  });
});

test("a mint over the rate limit names the wait and asks to try again later", async () => {
  const s = setup(
    grantThen([
      json(
        {
          error: "access_denied",
          coforge_code: "agent_credential_mint_rate_limited",
          retry_after: 240,
        },
        400,
      ),
    ]),
  );
  await expect(signIn(s.deps)).rejects.toMatchObject({
    code: "LOGIN_RATE_LIMITED",
    message: expect.stringContaining("4 minutes"),
    retryable: true,
  });
});

test("login start tells the person to choose the Agent on the page", async () => {
  const s = setup(grantThen([]));
  await runAgentLogin(login, undefined, s.deps);
  expect(s.text()).toContain("choose @builder in acme");
});

test.each([
  ["a key for another Agent", { agent_id: "a9", agent_name: "other" }, "@other"],
  ["a key in another Workspace", { workspace_slug: "elsewhere" }, "elsewhere"],
])("%s is refused, names what it is for, and saves nothing", async (_name, over, named) => {
  const s = setup(grantThen([json({ ...issued, ...over })]));
  await expect(signIn(s.deps)).rejects.toMatchObject({
    code: "AGENT_IDENTITY_MISMATCH",
    message: expect.stringContaining(named),
    suggestedNextAction: expect.stringContaining("Revoke"),
  });
  expect(await home.store.readProfile("acme-builder")).toBeUndefined();
  expect(await home.store.readPending("acme-builder")).toBeUndefined();
});

test("--agent may be the Agent's id", async () => {
  const s = setup(grantThen([json(issued)]));
  await runAgentLogin(
    parseAgentLoginArgs(["start", "--server", SERVER, "--workspace", "acme", "--agent", "a1"]),
    "by-id",
    s.deps,
  );
  await runAgentLogin(waiting, "by-id", s.deps);
  expect(await home.store.readProfile("by-id")).toMatchObject({ agentId: "a1" });
});

test("login start saves the pending sign-in, prints the page and code, and does not poll", async () => {
  const s = setup(grantThen([]));
  await runAgentLogin(login, undefined, s.deps);
  expect(s.text()).toContain("state: pending_human_action");
  expect(s.text()).toContain(`Open: ${SERVER}/device\n`);
  expect(s.text()).toContain("Code: ABCD-EFGH");
  const link = s.out.find((line) => line.includes("Open:")) ?? s.text();
  expect(link.split("\n").find((line) => line.startsWith("Open:"))).not.toContain("ABCD");
  expect(s.text()).toContain("coforge agent login wait --profile acme-builder");
  expect(s.text()).not.toContain(DEVICE_CODE);
  expect(s.requests.map((request) => request.url.pathname)).toEqual(["/oauth/device"]);
  const file = join(home.home, "profiles", "acme-builder", "pending.json");
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
    deviceCode: DEVICE_CODE,
    workspace: "acme",
    agent: "builder",
    interval: 5,
  });
});

test("login wait polls the saved sign-in and saves the key", async () => {
  const first = setup(grantThen([]));
  await runAgentLogin(login, undefined, first.deps);
  const second = setup(grantThen([json(issued)]));
  await runAgentLogin(waiting, undefined, second.deps);
  expect(second.text()).toContain("state: authorized");
  expect(second.requests.map((request) => request.url.pathname)).toEqual(["/oauth/token"]);
  expect((await home.store.readProfile("acme-builder"))?.apiKey).toBe(NEW_KEY);
  expect(await home.store.readPending("acme-builder")).toBeUndefined();
});

test("login wait without a pending sign-in says so", async () => {
  const s = setup(grantThen([]));
  await expect(runAgentLogin(waiting, "none", s.deps)).rejects.toMatchObject({
    code: "LOGIN_NOT_PENDING",
  });
  await expect(runAgentLogin(waiting, undefined, s.deps)).rejects.toMatchObject({
    code: "LOGIN_NOT_PENDING",
  });
});

test("a usable credential for the same Agent is reported without a new grant", async () => {
  await home.store.writeProfile("acme-builder", profile());
  const s = setup((request) =>
    request.url.pathname === "/api/agent/v1/context"
      ? json({ agent: { id: "a1" }, workspace: { slug: "acme" } })
      : json({}, 500),
  );
  await runAgentLogin(login, undefined, s.deps);
  expect(s.text()).toContain("state: already_logged_in");
  expect(s.requests.map((request) => request.url.pathname)).toEqual(["/api/agent/v1/context"]);
});

test("a profile bound to another Agent is never overwritten", async () => {
  await home.store.writeProfile("acme-builder", profile({ agentName: "other", agentId: "a9" }));
  const s = setup(grantThen([]));
  await expect(signIn(s.deps)).rejects.toMatchObject({
    code: "PROFILE_ALREADY_EXISTS",
  });
  expect(s.requests).toEqual([]);
  expect((await home.store.readProfile("acme-builder"))?.agentName).toBe("other");
});

test("corrupt credential.json does not block login or lose the newly issued key", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const dir = join(home.home, "profiles", "acme-builder");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "credential.json"), "{not-json", "utf8");
  const s = setup(grantThen([json(issued)]));
  await signIn(s.deps);
  expect(s.text()).toContain("state: authorized");
  expect((await home.store.readProfile("acme-builder"))?.apiKey).toBe(NEW_KEY);
});

test("a revoked credential is replaced and the old key is self-revoked after the new one is saved", async () => {
  await home.store.writeProfile("acme-builder", profile());
  const order: string[] = [];
  const s = setup((request) => {
    order.push(request.url.pathname);
    if (request.url.pathname === "/api/agent/v1/context")
      return json({ error: "unauthorized", code: "invalid_credential" }, 401);
    if (request.url.pathname === "/api/agent/v1/credentials/self/revoke")
      return json({ state: "revoked" });
    return grantThen([json(issued)])(request);
  });
  await signIn(s.deps);
  expect((await home.store.readProfile("acme-builder"))?.apiKey).toBe(NEW_KEY);
  const revoke = s.requests.find((request) => request.url.pathname.endsWith("/self/revoke"))!;
  expect(revoke.headers.get("authorization")).toBe(`Bearer ${OLD_KEY}`);
  expect(order.at(-1)).toBe("/api/agent/v1/credentials/self/revoke");
  expect(s.text()).toContain("Previous key: revoked.");
});

test("a failed rotation revoke is reported but the new key stays", async () => {
  await home.store.writeProfile("acme-builder", profile());
  const s = setup((request) => {
    if (request.url.pathname === "/api/agent/v1/context") return json({}, 401);
    if (request.url.pathname.endsWith("/self/revoke")) return json({}, 503);
    return grantThen([json(issued)])(request);
  });
  await signIn(s.deps);
  expect(s.text()).toContain("Previous key: not revoked (HTTP 503)");
  expect((await home.store.readProfile("acme-builder"))?.apiKey).toBe(NEW_KEY);
});

function contextOf(over: Record<string, unknown> = {}) {
  return {
    agent: { id: "a1", name: "builder", external: true },
    workspace: { id: "w1", slug: "acme", name: "Acme" },
    credential: { id: "c9" },
    ...over,
  };
}

const paste = parseAgentLoginArgs(["--server", SERVER, "--agent", "builder"]);

function pasteHandler(context: Handler = () => json(contextOf())): Handler {
  return (request) =>
    request.url.pathname === "/api/agent/v1/context"
      ? context(request)
      : request.url.pathname.endsWith("/self/revoke")
        ? json({ ok: true })
        : json({}, 404);
}

test("paste login verifies the key with /context and saves the profile under <workspace>-<agent>", async () => {
  pastedKey = `  ${NEW_KEY}\n`;
  const s = setup(pasteHandler());
  await runAgentLogin(paste, undefined, s.deps);
  expect(s.requests.map((request) => request.url.pathname)).toEqual(["/api/agent/v1/context"]);
  expect(s.requests[0]!.headers.get("authorization")).toBe(`Bearer ${NEW_KEY}`);
  expect(await home.store.readProfile("acme-builder")).toMatchObject({
    apiKey: NEW_KEY,
    agentId: "a1",
    agentName: "builder",
    credentialId: "c9",
    workspaceSlug: "acme",
    serverUrl: SERVER,
  });
  expect(s.text()).toContain("state: authorized");
  expect(s.text()).not.toContain(NEW_KEY);
  pastedKey = NEW_KEY;
});

test("paste login accepts the Agent's id as well as its name, and honours --profile", async () => {
  const s = setup(pasteHandler());
  await runAgentLogin(parseAgentLoginArgs(["--server", SERVER, "--agent", "A1"]), "mine", s.deps);
  expect((await home.store.readProfile("mine"))?.agentId).toBe("a1");
});

test("paste login refuses a key of another Agent and saves nothing", async () => {
  const s = setup(pasteHandler());
  await expect(
    runAgentLogin(parseAgentLoginArgs(["--server", SERVER, "--agent", "other"]), undefined, s.deps),
  ).rejects.toMatchObject({ code: "AGENT_MISMATCH" });
  expect(await home.store.readProfile("acme-builder")).toBeUndefined();
});

test("paste login refuses a rejected, a non-external and a malformed key", async () => {
  const rejected = setup(pasteHandler(() => json({ code: "invalid_credential" }, 401)));
  await expect(runAgentLogin(paste, undefined, rejected.deps)).rejects.toMatchObject({
    code: "EXTERNAL_KEY_INVALID",
  });
  const managed = setup(
    pasteHandler(() =>
      json(contextOf({ agent: { id: "a1", name: "builder", external: false }, credential: null })),
    ),
  );
  await expect(runAgentLogin(paste, undefined, managed.deps)).rejects.toMatchObject({
    code: "EXTERNAL_KEY_INVALID",
  });
  pastedKey = "sk_agent_nope";
  const malformed = setup(pasteHandler());
  await expect(runAgentLogin(paste, undefined, malformed.deps)).rejects.toMatchObject({
    code: "EXTERNAL_KEY_INVALID",
  });
  expect(malformed.requests).toEqual([]);
  pastedKey = NEW_KEY;
  expect(await home.store.readProfile("acme-builder")).toBeUndefined();
});

test("paste login on a profile holding another Agent's key is refused", async () => {
  await home.store.writeProfile("acme-builder", profile({ agentId: "a9", agentName: "other" }));
  const s = setup(pasteHandler());
  await expect(runAgentLogin(paste, undefined, s.deps)).rejects.toMatchObject({
    code: "PROFILE_ALREADY_EXISTS",
  });
  expect((await home.store.readProfile("acme-builder"))?.apiKey).toBe(OLD_KEY);
});

test("paste login again saves the new key first, then revokes the old one with the old key", async () => {
  await home.store.writeProfile("acme-builder", profile());
  const order: string[] = [];
  const s = setup((request) => {
    order.push(request.url.pathname);
    return pasteHandler()(request);
  });
  await runAgentLogin(paste, undefined, s.deps);
  expect((await home.store.readProfile("acme-builder"))?.apiKey).toBe(NEW_KEY);
  const revoke = s.requests.find((request) => request.url.pathname.endsWith("/self/revoke"))!;
  expect(revoke.headers.get("authorization")).toBe(`Bearer ${OLD_KEY}`);
  expect(order.at(-1)).toBe("/api/agent/v1/credentials/self/revoke");
  expect(s.text()).toContain("Previous key: revoked.");
});

test("a failed revoke of the old key keeps the new one and names the old credential id", async () => {
  await home.store.writeProfile("acme-builder", profile({ credentialId: "c-old" }));
  const s = setup((request) =>
    request.url.pathname.endsWith("/self/revoke") ? json({}, 503) : pasteHandler()(request),
  );
  await runAgentLogin(paste, undefined, s.deps);
  expect(s.text()).toContain("Previous key: not revoked (HTTP 503)");
  expect(s.text()).toContain("c-old");
  expect((await home.store.readProfile("acme-builder"))?.apiKey).toBe(NEW_KEY);
});

test("pasting the key already saved revokes nothing", async () => {
  await home.store.writeProfile("acme-builder", profile({ apiKey: NEW_KEY }));
  const s = setup(pasteHandler());
  await runAgentLogin(paste, undefined, s.deps);
  expect(s.requests.some((request) => request.url.pathname.endsWith("/self/revoke"))).toBe(false);
});

test("login arguments are checked", () => {
  expect(() => parseAgentLoginArgs([])).toThrow("Usage:");
  expect(() => parseAgentLoginArgs(["--server", SERVER])).toThrow("Usage:");
  expect(() => parseAgentLoginArgs(["--server", SERVER, "--agent", "a", "--key", "k"])).toThrow(
    "Usage:",
  );
  expect(() => parseAgentLoginArgs(["wait", "--agent", "x"])).toThrow("Usage:");
  expect(() => parseAgentLoginArgs(["start", "--server", SERVER, "--agent", "b"])).toThrow(
    "Usage:",
  );
  for (const removed of ["--resume", "--no-browser", "--no-wait"])
    expect(() => parseAgentLoginArgs(["--server", SERVER, "--agent", "b", removed])).toThrow(
      "Usage:",
    );
  expect(() =>
    parseAgentLoginArgs([
      "start",
      "--server",
      "http://forge.example",
      "--workspace",
      "a",
      "--agent",
      "b",
    ]),
  ).toThrow("https");
  expect(parseAgentLoginArgs(["--server", "http://localhost:3000/x", "--agent", "@b"])).toEqual({
    mode: "paste",
    server: "http://localhost:3000",
    agent: "b",
  });
  expect(parseAgentLoginArgs(["wait"])).toEqual({ mode: "wait" });
});
