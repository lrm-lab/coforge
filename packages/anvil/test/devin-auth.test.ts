import { expect, test } from "bun:test";
import type { DevinAuthProcess } from "#src/devin/auth";
import { DevinRuntimeAuthAdapter } from "#src/devin/auth";
import type { RuntimeAuthLoginEvent } from "#src/contract";

const LOGGED_IN = `Logged in (via Devin).

Credentials:
  File:              /Users/someone/.local/share/devin/credentials.toml

User:
  Name:              Frank An
  Email:             user@example.com

Account:
  Tier:              Devin Pro
  Plan:              Pro
`;

function processWith(text: string, exitCode = 0): DevinAuthProcess {
  return {
    output: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
    exited: Promise.resolve(exitCode),
    write() {},
    async dispose() {},
  };
}

function adapter(options: {
  status: () => { text: string; exitCode?: number };
  login?: () => { text: string; exitCode?: number };
  logout?: () => { text: string; exitCode?: number };
}) {
  const calls: string[] = [];
  const value = new DevinRuntimeAuthAdapter({
    terminalLoginSupported: false,
    maskAccountLabel: (value) => (value === "user@example.com" ? "u****@example.com" : undefined),
    spawn(args) {
      const command = args.join(" ");
      calls.push(command);
      if (command === "auth status") {
        const status = options.status();
        return processWith(status.text, status.exitCode);
      }
      if (command === "auth login") {
        const login = options.login?.() ?? { text: "", exitCode: 0 };
        return processWith(login.text, login.exitCode);
      }
      const logout = options.logout?.() ?? { text: "", exitCode: 0 };
      return processWith(logout.text, logout.exitCode);
    },
  });
  return { adapter: value, calls };
}

test("a signed-in Devin reports its plan and masked email, never the name, address or credentials file", async () => {
  const { adapter: value } = adapter({ status: () => ({ text: LOGGED_IN }) });
  const status = await value.readStatus({ workingDirectory: "/tmp" });
  expect(status).toEqual({
    provider: "devin",
    state: "logged_in",
    account: { maskedLabel: "u****@example.com", planLabel: "Pro", methodLabel: "Devin" },
  });
  expect(JSON.stringify(status)).not.toMatch(/user@|Frank|credentials/);
});

test("a signed-out Devin is logged out and an unreadable report is unknown", async () => {
  const loggedOut = adapter({
    status: () => ({
      text: "Not logged in. Run `devin auth login`.",
      exitCode: 1,
    }),
  });
  expect(await loggedOut.adapter.readStatus({ workingDirectory: "/tmp" })).toEqual({
    provider: "devin",
    state: "logged_out",
  });
  const unknown = adapter({ status: () => ({ text: "garbled output" }) });
  expect(await unknown.adapter.readStatus({ workingDirectory: "/tmp" })).toEqual({
    provider: "devin",
    state: "unknown",
  });
});

test("login relays the browser link and confirms the signed-in account", async () => {
  let signedIn = false;
  const { adapter: value, calls } = adapter({
    status: () => (signedIn ? { text: LOGGED_IN } : { text: "Not logged in.", exitCode: 1 }),
    login: () => {
      signedIn = true;
      return {
        text: "Opening browser: https://app.devin.ai/login?state=abc\n",
      };
    },
  });
  const events: RuntimeAuthLoginEvent[] = [];
  const result = await value.startLogin(
    { workingDirectory: "/tmp" },
    { onEvent: (event) => events.push(event), prompt: async () => "" },
  );
  expect(events).toEqual([
    {
      kind: "auth_url",
      verificationUrl: "https://app.devin.ai/login?state=abc",
    },
  ]);
  expect(result).toMatchObject({
    status: "logged_in",
    authStatus: { provider: "devin", state: "logged_in" },
  });
  expect(calls).toEqual(["auth login", "auth status"]);
});

test("every distinct link the CLI prints is relayed, not only the first", async () => {
  let signedIn = false;
  const { adapter: value } = adapter({
    status: () => (signedIn ? { text: LOGGED_IN } : { text: "Not logged in.", exitCode: 1 }),
    login: () => {
      signedIn = true;
      return {
        text:
          "For help see https://docs.devin.ai/cli\n" +
          "Open https://app.devin.ai/auth?code=abc to sign in\n",
      };
    },
  });
  const events: RuntimeAuthLoginEvent[] = [];
  const result = await value.startLogin(
    { workingDirectory: "/tmp" },
    { onEvent: (event) => events.push(event), prompt: async () => "" },
  );
  expect(events).toEqual([
    { kind: "auth_url", verificationUrl: "https://docs.devin.ai/cli" },
    { kind: "auth_url", verificationUrl: "https://app.devin.ai/auth?code=abc" },
  ]);
  expect(result.status).toBe("logged_in");
});

function streamingProcess() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const output = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
  });
  const exit = Promise.withResolvers<number>();
  return {
    process: {
      output,
      exited: exit.promise,
      write() {},
      async dispose() {},
    } satisfies DevinAuthProcess,
    write(text: string) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    finish(code = 0) {
      controller.close();
      exit.resolve(code);
    },
  };
}

test("a link the CLI prints without a newline is relayed while it waits", async () => {
  let signedIn = false;
  const login = streamingProcess();
  let events: RuntimeAuthLoginEvent[] = [];
  const value = new DevinRuntimeAuthAdapter({
    terminalLoginSupported: false,
    maskAccountLabel: () => undefined,
    spawn(args) {
      if (args.join(" ") === "auth login") return login.process;
      signedIn = true;
      return processWith(LOGGED_IN);
    },
  });
  const done = value.startLogin(
    { workingDirectory: "/tmp" },
    { onEvent: (event) => events.push(event), prompt: async () => "" },
  );
  login.write("Opening browser: https://app.devin.ai/auth?code=abc");
  const deadline = Date.now() + 2_000;
  while (events.length === 0 && Date.now() < deadline) await Bun.sleep(10);
  expect(events).toEqual([
    { kind: "auth_url", verificationUrl: "https://app.devin.ai/auth?code=abc" },
  ]);
  login.finish();
  await expect(done).resolves.toMatchObject({ status: "logged_in" });
});

test("a URL split across two reads is relayed once and whole", async () => {
  const login = streamingProcess();
  const events: RuntimeAuthLoginEvent[] = [];
  let statusReads = 0;
  const value = new DevinRuntimeAuthAdapter({
    terminalLoginSupported: false,
    maskAccountLabel: () => undefined,
    spawn(args) {
      if (args.join(" ") === "auth login") return login.process;
      statusReads++;
      return processWith(LOGGED_IN);
    },
  });
  const done = value.startLogin(
    { workingDirectory: "/tmp" },
    { onEvent: (event) => events.push(event), prompt: async () => "" },
  );
  login.write("Open https://app.devin.ai/au");
  await Bun.sleep(40);
  login.write("th?code=abc\n");
  login.finish();
  await expect(done).resolves.toMatchObject({ status: "logged_in" });
  expect(statusReads).toBe(1);
  expect(events).toEqual([
    { kind: "auth_url", verificationUrl: "https://app.devin.ai/auth?code=abc" },
  ]);
});

test("a login the CLI fails before signing in is a process failure", async () => {
  const { adapter: value } = adapter({
    status: () => ({ text: "Not logged in.", exitCode: 1 }),
    login: () => ({ text: "browser unavailable", exitCode: 1 }),
  });
  expect(
    await value.startLogin(
      { workingDirectory: "/tmp" },
      { onEvent: () => {}, prompt: async () => "" },
    ),
  ).toEqual({ status: "failed", reason: "process_failed" });
});

test("logout signs the CLI out and verifies it", async () => {
  let signedIn = true;
  const { adapter: value } = adapter({
    status: () => (signedIn ? { text: LOGGED_IN } : { text: "Not logged in.", exitCode: 1 }),
    logout: () => {
      signedIn = false;
      return { text: "Logged out.\n" };
    },
  });
  expect(await value.logout({ workingDirectory: "/tmp" })).toMatchObject({
    status: "logged_out",
    authStatus: { provider: "devin", state: "logged_out" },
  });
});

function terminalLogin(options: { exitAfterCode?: number } = {}) {
  const login = streamingProcess();
  const writes: string[] = [];
  const spawns: Array<{ args: string; terminal: boolean | undefined }> = [];
  let signedIn = false;
  const value = new DevinRuntimeAuthAdapter({
    terminalLoginSupported: true,
    maskAccountLabel: () => undefined,
    spawn(args, _cwd, terminal) {
      spawns.push({ args: args.join(" "), terminal });
      if (args[1] === "login")
        return {
          ...login.process,
          write(text: string) {
            writes.push(text);
            signedIn = options.exitAfterCode === undefined || options.exitAfterCode === 0;
            login.finish(options.exitAfterCode ?? 0);
          },
        };
      return signedIn ? processWith(LOGGED_IN) : processWith("Not logged in.", 0);
    },
  });
  return { value, login, writes, spawns };
}

// What Devin CLI 3000.11.228 prints on a terminal: an OSC 8 hyperlink and a bracketed-paste prompt.
const MANUAL_PROMPT =
  "\x1b]8;;https://app.devin.ai/auth/cli/continue?state=abc\x1b\\Visit https://app.devin.ai/auth/cli/continue?state=abc\x1b]8;;\x1b\\ to sign in, then copy the code and paste it below.\n\n\x1b[?2004h";

test("terminal login relays the clean link, asks the Web for the code and types it", async () => {
  const { value, login, writes, spawns } = terminalLogin();
  const events: RuntimeAuthLoginEvent[] = [];
  const secrets: string[] = [];
  const done = value.startLogin(
    { workingDirectory: "/tmp", onSecret: (secret) => secrets.push(secret) },
    {
      onEvent: (event) => events.push(event),
      prompt: async () => "  CODE-123 \n",
    },
  );
  login.write(MANUAL_PROMPT);
  await expect(done).resolves.toMatchObject({
    status: "logged_in",
    authStatus: { state: "logged_in" },
  });
  expect(spawns[0]).toEqual({
    args: "auth login --force-manual-token-flow",
    terminal: true,
  });
  expect(events).toEqual([
    {
      kind: "auth_url",
      verificationUrl: "https://app.devin.ai/auth/cli/continue?state=abc",
    },
  ]);
  expect(writes).toEqual(["CODE-123\r"]);
  expect(secrets).toEqual(["CODE-123"]);
});

test("a code Devin refuses is a rejected login", async () => {
  const { value, login } = terminalLogin({ exitAfterCode: 1 });
  const done = value.startLogin(
    { workingDirectory: "/tmp" },
    { onEvent: () => {}, prompt: async () => "WRONG" },
  );
  login.write(MANUAL_PROMPT);
  await expect(done).resolves.toEqual({ status: "failed", reason: "rejected" });
});

test("a CLI that exits while the code is still being asked for is not waited on", async () => {
  const { value, login } = terminalLogin();
  const done = value.startLogin(
    { workingDirectory: "/tmp" },
    { onEvent: () => {}, prompt: () => new Promise<string>(() => {}) },
  );
  login.write(MANUAL_PROMPT);
  await Bun.sleep(20);
  login.finish(1);
  await expect(done).resolves.toEqual({
    status: "failed",
    reason: "process_failed",
  });
});
