import { test, expect } from "bun:test";

import { oneShotAttach, OneShotAttachFailedError } from "#src/setup/one-shot-attach";

/** `attach --one-shot` (task #417 step 3): the code and link print once, the poll honors the
 * device's statuses, and only the server's explicit `attach.session-fallback` sends the caller
 * back to login — a timeout, a 5xx, or a network drop is an error, never a silent fallback. */
const machine = {
  serverUrl: "http://server",
  sleep: async () => {},
  machineName: "dev-box",
  hostname: "dev.local",
  os: "linux",
};

const fetchFor = (responses: Response[]) => {
  const queue = [...responses];
  return (async () =>
    queue.shift() ?? new Response("{}", { status: 500 })) as unknown as typeof fetch;
};

const startResponse = () =>
  Response.json({
    sessionId: "s1",
    deviceCode: "cd_x",
    userCode: "ABCD2345",
    approveUrl: "http://server/computers/attach/s1",
    expiresInSeconds: 600,
  });

test("the approval link and code print once, and a pending poll waits for the token", async () => {
  const written: string[] = [];
  const { accessToken } = await oneShotAttach(
    { ...machine, write: (line) => written.push(line) },
    fetchFor([
      startResponse(),
      Response.json({ error: "attach_pending" }, { status: 400 }),
      Response.json({ attachToken: "at_secret" }),
    ]),
  );
  expect(accessToken).toBe("at_secret");
  // The link and code print once; the deviceCode is a bearer secret and never appears.
  expect(written.join("\n")).toContain("ABCD2345");
  expect(written.join("\n")).toContain("http://server/computers/attach/s1");
  expect(written.join("\n")).not.toContain("cd_x");
});

test("a refused approve stops with ATTACH_DENIED, an expired one ATTACH_EXPIRED", async () => {
  await expect(
    oneShotAttach(
      machine,
      fetchFor([startResponse(), Response.json({ error: "access_denied" }, { status: 400 })]),
    ),
  ).rejects.toMatchObject({ code: "ATTACH_DENIED" });
  await expect(
    oneShotAttach(
      machine,
      fetchFor([startResponse(), Response.json({ error: "expired_token" }, { status: 400 })]),
    ),
  ).rejects.toMatchObject({ code: "ATTACH_EXPIRED" });
});

test("only an explicit attach.session-fallback is a fallback; a 404 start is one, a 500 is not", async () => {
  // A 404/405 from attach/start is an error, not a fallback — only the server's explicit
  // attach.session-fallback names the path back (task #417).
  await expect(
    oneShotAttach(machine, fetchFor([new Response("not found", { status: 404 })])),
  ).rejects.toMatchObject({ code: "ATTACH_START_FAILED", sessionFallback: false });
  // A mid-poll fallback the server names is one too.
  await expect(
    oneShotAttach(
      machine,
      fetchFor([
        startResponse(),
        Response.json({ error: "attach.session-fallback" }, { status: 400 }),
      ]),
    ),
  ).rejects.toMatchObject({ sessionFallback: true });
  // A 500 is not a fallback — it is an error.
  await expect(
    oneShotAttach(machine, fetchFor([new Response("server error", { status: 500 })])),
  ).rejects.toMatchObject({ sessionFallback: false });
  // A network drop is not a fallback either.
  await expect(
    oneShotAttach(machine, (async () => {
      throw new Error("connection reset");
    }) as unknown as typeof fetch),
  ).rejects.toMatchObject({ sessionFallback: false });
});

test("a run of server errors gives up instead of retrying forever", async () => {
  await expect(
    oneShotAttach(
      machine,
      fetchFor([
        startResponse(),
        new Response("err", { status: 500 }),
        new Response("err", { status: 500 }),
        new Response("err", { status: 500 }),
        new Response("err", { status: 500 }),
        new Response("err", { status: 500 }),
      ]),
    ),
  ).rejects.toMatchObject({ code: "ATTACH_START_FAILED" });
});

test("polling stops at the session's deadline instead of forever", async () => {
  // A session whose expiry is already past: the first deadline check fires.
  const expiredStart = () =>
    Response.json({
      sessionId: "s1",
      deviceCode: "cd_x",
      userCode: "ABCD2345",
      approveUrl: "http://server/computers/attach/s1",
      expiresInSeconds: -70,
    });
  await expect(
    oneShotAttach(machine, fetchFor([expiredStart(), Response.json({ error: "attach_pending" })])),
  ).rejects.toMatchObject({ code: "ATTACH_EXPIRED" });
});
