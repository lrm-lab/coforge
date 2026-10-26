import { expect, test } from "bun:test";
import { KiroRuntimeAuthAdapter, type KiroAuthHost, type KiroAuthProcess } from "#src/kiro/auth";
import type { RuntimeAuthLoginEvent } from "#src/contract";
const target = { startUrl: "https://example.awsapps.com/start", region: "us-east-1" };
const identity =
  JSON.stringify({ accountType: "IamIdentityCenter", email: "alice@example.com", ...target }) +
  "\nProfile:\nexample";
function child() {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let streamClosed = false;
  const output = new ReadableStream<Uint8Array>({
    start(c) {
      stream = c;
    },
    cancel() {
      streamClosed = true;
    },
  });
  const exit = Promise.withResolvers<number>();
  let closed = false;
  const writes: string[] = [];
  const send = (s: string) => stream.enqueue(new TextEncoder().encode(s));
  const end = (code = 0) => {
    if (!closed) {
      closed = true;
      if (!streamClosed) stream.close();
      exit.resolve(code);
    }
  };
  const process: KiroAuthProcess = {
    output,
    exited: exit.promise,
    write: (s) => {
      writes.push(s);
    },
    dispose: async () => {
      end(137);
    },
  };
  return {
    process,
    send,
    end,
    writes,
    get closed() {
      return closed;
    },
  };
}
function setup() {
  const login = child();
  const spawned = Promise.withResolvers<void>();
  const commands: readonly string[][] = [];
  const host: KiroAuthHost = {
    enterpriseLoginSupported: true,
    maskAccountLabel: () => "a***@example.com",
    spawn(args, _cwd, terminal) {
      (commands as string[][]).push([...args]);
      if (terminal) {
        spawned.resolve();
        return login.process;
      }
      const p = child();
      p.send(identity);
      p.end();
      return p.process;
    },
  };
  const adapter = new KiroRuntimeAuthAdapter(host);
  const events: RuntimeAuthLoginEvent[] = [];
  const signIn = (signal?: AbortSignal, timeoutMs = 1000) =>
    adapter.startLogin(
      { workingDirectory: "/test", kiroIdentityCenter: target, timeoutMs },
      {
        signal,
        onEvent: (e) => events.push(e),
        prompt: async () => {
          throw new Error("no manual code expected");
        },
      },
    );
  return { login, spawned, adapter, events, signIn, commands };
}

test("Kiro IDC answers only its two prefilled prompts and verifies the resulting identity", async () => {
  const x = setup();
  const pending = x.signIn();
  await x.spawned.promise;
  x.login.send(
    "? Enter Start URL › https://example.awsapps.com/start\r\n? Enter Region › us-east-1\r\n",
  );
  x.login.send("Open https://device.sso.us-east-1.amazonaws.com/\nCode: ABCD-EFGH\n");
  x.login.end();
  const result = await pending;
  expect(x.login.writes).toEqual(["\r", "\r"]);
  expect(x.commands[0]).toEqual([
    "login",
    "--license",
    "pro",
    "--identity-provider",
    target.startUrl,
    "--region",
    target.region,
    "--use-device-flow",
  ]);
  expect(x.events).toContainEqual({
    kind: "device_code",
    verificationUrl: "https://device.sso.us-east-1.amazonaws.com/",
    userCode: "ABCD-EFGH",
  });
  expect(result).toMatchObject({
    status: "logged_in",
    authStatus: { provider: "kiro", account: { maskedLabel: "a***@example.com" } },
  });
  expect(x.login.closed).toBe(true);
});

test("Kiro refuses an unrecognized terminal prompt and closes its process", async () => {
  const x = setup();
  const pending = x.signIn();
  await x.spawned.promise;
  x.login.send("? Enter password › ");
  expect(await pending).toMatchObject({ status: "failed", reason: "interaction_failed" });
  expect(x.login.writes).toEqual([]);
  expect(x.login.closed).toBe(true);
});

for (const mode of ["cancel", "deadline", "dispose"] as const)
  test(`Kiro ${mode} releases the login process`, async () => {
    const x = setup();
    const abort = new AbortController();
    const pending = x.signIn(abort.signal, mode === "deadline" ? 20 : 1000);
    await x.spawned.promise;
    if (mode === "cancel") abort.abort();
    if (mode === "dispose") await x.adapter.dispose();
    expect(await pending).toMatchObject(
      mode === "deadline" ? { status: "failed", reason: "timed_out" } : { status: "cancelled" },
    );
    expect(x.login.closed).toBe(true);
  });

test("Kiro terminal framing survives prompts split across data chunks", async () => {
  const x = setup();
  const pending = x.signIn();
  await x.spawned.promise;
  for (const chunk of [
    "? En",
    "ter Start URL › ",
    target.startUrl,
    "\r\n? Enter Reg",
    "ion › us-east-1\r\n",
    "Open https://device.sso.us-east-1.amazonaws.com/\nCode: ABCD-EFGH\n",
  ])
    x.login.send(chunk);
  x.login.end();
  expect(await pending).toMatchObject({ status: "logged_in" });
  expect(x.login.writes).toEqual(["\r", "\r"]);
});

for (const [text, reason, detail] of [
  ["Device flow is disabled by your organization", "rejected", "kiro_device_flow_disabled"],
  ["External identity provider is not supported", "rejected", "kiro_external_idp_unsupported"],
  ["access_denied", "rejected", undefined],
  ["expired_token", "timed_out", undefined],
] as const)
  test(`Kiro classifies explicit provider refusal: ${text}`, async () => {
    const x = setup();
    const pending = x.signIn();
    await x.spawned.promise;
    x.login.send(text);
    expect(await pending).toEqual({ status: "failed", reason, ...(detail ? { detail } : {}) });
    expect(x.login.closed).toBe(true);
  });

test("cancel during whoami verification waits for that process to be disposed", async () => {
  const login = child(),
    probe = child();
  const probing = Promise.withResolvers<void>();
  const adapter = new KiroRuntimeAuthAdapter({
    enterpriseLoginSupported: true,
    maskAccountLabel: () => undefined,
    spawn(_args, _cwd, terminal) {
      if (terminal) return login.process;
      probing.resolve();
      return probe.process;
    },
  });
  const abort = new AbortController();
  const pending = adapter.startLogin(
    { workingDirectory: "/test", kiroIdentityCenter: target },
    { signal: abort.signal, onEvent: () => {}, prompt: async () => "" },
  );
  login.end();
  await probing.promise;
  abort.abort();
  expect(await pending).toEqual({ status: "cancelled" });
  expect(probe.closed).toBe(true);
});

test("a long native waiting spinner does not exhaust a healthy enterprise login", async () => {
  const x = setup();
  const pending = x.signIn();
  await x.spawned.promise;
  x.login.send("Open https://device.sso.us-east-1.amazonaws.com/\nCode: ABCD-EFGH\n");
  x.login.send("\rWaiting for authorization...".repeat(5000));
  x.login.end();
  expect(await pending).toMatchObject({ status: "logged_in" });
  expect(x.events).toHaveLength(1);
});

for (const missingExecutable of [true, false]) {
  test(`Kiro host failure classifies ${missingExecutable ? "missing executable" : "missing cwd"} correctly`, async () => {
    const adapter = new KiroRuntimeAuthAdapter({
      enterpriseLoginSupported: true,
      maskAccountLabel: (label) => label,
      spawn() {
        throw Object.assign(new Error("fixture spawn failure"), {
          code: missingExecutable ? "runtime_not_found" : "ENOENT",
        });
      },
    });
    expect(await adapter.readStatus({ workingDirectory: "/test" })).toEqual(
      missingExecutable
        ? { provider: "kiro", state: "unavailable", unavailableReason: "not_installed" }
        : { provider: "kiro", state: "unknown" },
    );
    expect(
      await adapter.startLogin(
        { workingDirectory: "/test", kiroIdentityCenter: target },
        {
          onEvent() {},
          async prompt() {
            throw new Error("unexpected prompt");
          },
        },
      ),
    ).toEqual(
      missingExecutable
        ? { status: "unsupported", reason: "not_installed" }
        : { status: "failed", reason: "interaction_failed" },
    );
  });
}
