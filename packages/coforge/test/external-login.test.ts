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
  };
  return { deps, out, sleeps, requests: fake.requests, text: () => out.join("") };
}

const login = parseAgentLoginArgs([
  "--server",
  SERVER,
  "--workspace",
  "acme",
  "--agent",
  "@builder",
]);

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
  await runAgentLogin(login, undefined, s.deps);
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

test("the device grant request carries the workspace, agent and machine, and never the key", async () => {
  const s = setup(grantThen([json(issued)]));
  await runAgentLogin(login, undefined, s.deps);
  const device = new URLSearchParams(s.requests[0]!.body);
  expect(Object.fromEntries(device)).toEqual({
    client_id: "coforge-cli",
    workspace: "acme",
    agent: "builder",
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
  await runAgentLogin(login, undefined, s.deps);
  expect(s.text()).not.toContain(DEVICE_CODE);
  expect(s.text()).not.toContain(NEW_KEY);
});

test("slow_down adds five seconds to the polling interval", async () => {
  const s = setup(grantThen([json({ error: "slow_down" }, 400), pending(), json(issued)]));
  await runAgentLogin(login, undefined, s.deps);
  expect(s.sleeps).toEqual([5000, 10_000, 10_000]);
});

test("a code that is never approved expires and removes the pending sign-in", async () => {
  const s = setup(grantThen([]));
  await expect(runAgentLogin(login, undefined, s.deps)).rejects.toMatchObject({
    code: "DEVICE_CODE_EXPIRED",
  });
  expect(await home.store.readPending("acme-builder")).toBeUndefined();
  expect(await home.store.readProfile("acme-builder")).toBeUndefined();
});

test("expired_token from the server tells the person to run login again", async () => {
  const s = setup(grantThen([json({ error: "expired_token" }, 400)]));
  await expect(runAgentLogin(login, undefined, s.deps)).rejects.toMatchObject({
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
  await expect(runAgentLogin(login, undefined, s.deps)).rejects.toMatchObject({
    code,
    message: expect.stringContaining(words),
  });
});

test("a plain access_denied is a denial and invalid_grant a stale code", async () => {
  const denied = setup(grantThen([json({ error: "access_denied" }, 400)]));
  await expect(runAgentLogin(login, undefined, denied.deps)).rejects.toMatchObject({
    code: "LOGIN_DENIED",
  });
  const stale = setup(grantThen([json({ error: "invalid_grant" }, 400)]));
  await expect(runAgentLogin(login, undefined, stale.deps)).rejects.toMatchObject({
    code: "DEVICE_CODE_INVALID",
  });
});

test("an unknown Agent or a managed one is refused when the grant starts", async () => {
  const missing = setup(() =>
    json(
      { error: "invalid_request", error_description: "x", coforge_code: "agent_not_found" },
      400,
    ),
  );
  await expect(runAgentLogin(login, undefined, missing.deps)).rejects.toMatchObject({
    code: "AGENT_NOT_FOUND",
  });
  const managed = setup(() =>
    json(
      { error: "invalid_request", error_description: "x", coforge_code: "agent_not_external" },
      400,
    ),
  );
  await expect(runAgentLogin(login, undefined, managed.deps)).rejects.toMatchObject({
    code: "AGENT_NOT_EXTERNAL",
  });
  expect(await home.store.readPending("acme-builder")).toBeUndefined();
});

test("--no-wait saves the pending sign-in and prints how to resume", async () => {
  const s = setup(grantThen([]));
  await runAgentLogin({ ...login, noWait: true } as typeof login, undefined, s.deps);
  expect(s.text()).toContain("state: pending_human_action");
  expect(s.text()).toContain("Code: ABCD-EFGH");
  expect(s.text()).toContain("coforge agent login --resume --profile acme-builder");
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

test("--resume polls the saved sign-in and saves the key", async () => {
  const first = setup(grantThen([]));
  await runAgentLogin({ ...login, noWait: true } as typeof login, undefined, first.deps);
  const second = setup(grantThen([json(issued)]));
  await runAgentLogin(parseAgentLoginArgs(["--resume"]), undefined, second.deps);
  expect(second.text()).toContain("state: authorized");
  expect(second.requests.map((request) => request.url.pathname)).toEqual(["/oauth/token"]);
  expect((await home.store.readProfile("acme-builder"))?.apiKey).toBe(NEW_KEY);
  expect(await home.store.readPending("acme-builder")).toBeUndefined();
});

test("--resume without a pending sign-in says so", async () => {
  const s = setup(grantThen([]));
  await expect(runAgentLogin({ resume: true }, "none", s.deps)).rejects.toMatchObject({
    code: "LOGIN_NOT_PENDING",
  });
  await expect(runAgentLogin({ resume: true }, undefined, s.deps)).rejects.toMatchObject({
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
  await expect(runAgentLogin(login, undefined, s.deps)).rejects.toMatchObject({
    code: "PROFILE_ALREADY_EXISTS",
  });
  expect(s.requests).toEqual([]);
  expect((await home.store.readProfile("acme-builder"))?.agentName).toBe("other");
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
  await runAgentLogin(login, undefined, s.deps);
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
  await runAgentLogin(login, undefined, s.deps);
  expect(s.text()).toContain("Previous key: not revoked (HTTP 503)");
  expect((await home.store.readProfile("acme-builder"))?.apiKey).toBe(NEW_KEY);
});

test("login arguments are checked", () => {
  expect(() => parseAgentLoginArgs([])).toThrow("Usage:");
  expect(() => parseAgentLoginArgs(["--resume", "--agent", "x"])).toThrow("Usage:");
  expect(() =>
    parseAgentLoginArgs(["--server", "http://forge.example", "--workspace", "a", "--agent", "b"]),
  ).toThrow("https");
  expect(
    parseAgentLoginArgs([
      "--server",
      "http://localhost:3000/x",
      "--workspace",
      "a",
      "--agent",
      "b",
      "--no-browser",
    ]),
  ).toMatchObject({
    server: "http://localhost:3000",
    noBrowser: true,
  });
});
