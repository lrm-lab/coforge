import { expect, test } from "bun:test";
import { runAgentLogout, runAgentStatus } from "../src/external/profile-commands";
import { OLD_KEY, fakeFetch, json, profile, useAgentHome, type Handler } from "./external-fixture";

const home = useAgentHome();

function deps(handler: Handler) {
  const fake = fakeFetch(handler);
  return { store: home.store, fetch: fake.fetch as never, requests: fake.requests };
}

const context = (agentId = "a1") => json({ agent: { id: agentId }, workspace: { slug: "acme" } });

test.each([
  ["usable", () => context(), 0],
  ["revoked", () => json({ code: "invalid_credential" }, 401), 1],
  ["mismatch", () => context("other"), 1],
  ["unverified", () => json({}, 503), 1],
])("status reports %s", async (state, handler, exitCode) => {
  await home.store.writeProfile("p", profile());
  const result = await runAgentStatus([], "p", deps(handler));
  expect(result.output).toContain(`state: ${state}`);
  expect(result.exitCode).toBe(exitCode);
  expect(result.output).not.toContain(OLD_KEY);
});

test("status of an unreachable server is unverified, of no profile is missing", async () => {
  await home.store.writeProfile("p", profile());
  const down = deps(() => {
    throw new Error("offline");
  });
  expect((await runAgentStatus([], "p", down)).output).toContain("state: unverified");
  expect(
    (
      await runAgentStatus(
        [],
        "none",
        deps(() => context()),
      )
    ).output,
  ).toContain("state: missing");
  await home.store.removeProfile("p");
  expect(
    (
      await runAgentStatus(
        [],
        undefined,
        deps(() => context()),
      )
    ).output,
  ).toContain("state: missing");
});

test("status probes GET /context with the profile's key", async () => {
  await home.store.writeProfile("p", profile());
  const d = deps(() => context());
  await runAgentStatus([], undefined, d);
  expect(d.requests[0]!.url.href).toBe("https://forge.example/api/agent/v1/context");
  expect(d.requests[0]!.headers.get("authorization")).toBe(`Bearer ${OLD_KEY}`);
});

test("several profiles need a selection", async () => {
  await home.store.writeProfile("a", profile());
  await home.store.writeProfile("b", profile());
  await expect(
    runAgentStatus(
      [],
      undefined,
      deps(() => context()),
    ),
  ).rejects.toMatchObject({ code: "PROFILE_AMBIGUOUS" });
  await expect(
    runAgentLogout(
      [],
      undefined,
      deps(() => context()),
    ),
  ).rejects.toMatchObject({ code: "PROFILE_AMBIGUOUS" });
});

test("logout revokes the key, deletes the credential and the cursor", async () => {
  await home.store.writeProfile("p", profile());
  await home.store.writeCursor("p", "c");
  const d = deps(() => json({ state: "revoked" }));
  const output = await runAgentLogout([], undefined, d);
  expect(output).toContain("state: logged_out");
  expect(d.requests[0]).toMatchObject({ method: "POST" });
  expect(d.requests[0]!.url.pathname).toBe("/api/agent/v1/credentials/self/revoke");
  expect(d.requests[0]!.headers.get("authorization")).toBe(`Bearer ${OLD_KEY}`);
  expect(await home.store.readProfile("p")).toBeUndefined();
  expect(await home.store.readCursor("p")).toBeUndefined();
});

test("logout of a key the server already rejects still deletes it", async () => {
  await home.store.writeProfile("p", profile());
  const output = await runAgentLogout(
    [],
    "p",
    deps(() => json({ code: "invalid_credential" }, 401)),
  );
  expect(output).toContain("already revoked");
  expect(await home.store.readProfile("p")).toBeUndefined();
});

test("logout that cannot reach the server keeps the credential and fails", async () => {
  await home.store.writeProfile("p", profile());
  const offline = deps(() => {
    throw new Error("offline");
  });
  await expect(runAgentLogout([], "p", offline)).rejects.toMatchObject({
    code: "CREDENTIAL_REVOKE_FAILED",
  });
  await expect(
    runAgentLogout(
      [],
      "p",
      deps(() => json({}, 502)),
    ),
  ).rejects.toMatchObject({ code: "CREDENTIAL_REVOKE_FAILED" });
  expect(await home.store.readProfile("p")).toEqual(profile());
});

test("logout with no profile is not_logged_in", async () => {
  expect(
    await runAgentLogout(
      [],
      undefined,
      deps(() => context()),
    ),
  ).toBe("state: not_logged_in");
  expect(
    await runAgentLogout(
      [],
      "p",
      deps(() => context()),
    ),
  ).toBe("state: not_logged_in");
});
