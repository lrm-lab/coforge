import { expect, test } from "bun:test";
import type { RuntimeAuthLoginEvent } from "@lrm/coforge-anvil";
import {
  ClaudeRuntimeAuthAdapter,
  type ClaudeAuthProcess,
  type ClaudeAuthProcessFactory,
} from "#src/code-agent/claude-code/auth";

/** A scripted `claude auth ...` child: the test pushes stdout text and decides when it exits. */
class FakeAuthProcess implements ClaudeAuthProcess {
  readonly written: string[] = [];
  killed = false;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  #push!: (text: string) => void;
  #pushError!: (text: string) => void;
  #close!: () => void;
  #closeError!: () => void;
  #exit!: (code: number) => void;
  constructor() {
    this.stdout = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const encoder = new TextEncoder();
        this.#push = (text) => controller.enqueue(encoder.encode(text));
        this.#close = () => controller.close();
      },
    });
    this.stderr = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const encoder = new TextEncoder();
        this.#pushError = (text) => controller.enqueue(encoder.encode(text));
        this.#closeError = () => controller.close();
      },
    });
    this.exited = new Promise<number>((resolve) => (this.#exit = resolve));
  }
  write(text: string) {
    this.written.push(text);
  }
  kill() {
    this.killed = true;
    this.finish(143);
  }
  say(text: string) {
    this.#push(text);
  }
  complain(text: string) {
    this.#pushError(text);
  }
  finish(code: number) {
    try {
      this.#close();
      this.#closeError();
    } catch {
      // Already closed by an earlier finish.
    }
    this.#exit(code);
  }
}

const OAUTH_URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&response_type=code&state=xyz";
const STATUS_IN = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  email: "someone.long@example.com",
  subscriptionType: "max",
});

/** `claude auth status --json` answers `statusOutput`; `claude auth login` is the scripted child. */
function adapterWith(
  login: FakeAuthProcess,
  statusOutput = STATUS_IN,
  version = "2.1.310 (Claude Code)",
) {
  const commands: string[][] = [];
  const create: ClaudeAuthProcessFactory = (command) => {
    commands.push([...command]);
    if (command[2] === "login") return login;
    const process = new FakeAuthProcess();
    queueMicrotask(() => {
      process.say(command[1] === "--version" ? version : statusOutput);
      process.finish(command[2] === "logout" ? 0 : 0);
    });
    return process;
  };
  return { adapter: new ClaudeRuntimeAuthAdapter({ create }), commands };
}

test("reads a signed-in account with a masked email", async () => {
  const { adapter } = adapterWith(new FakeAuthProcess());
  const status = await adapter.readStatus({ workingDirectory: "/tmp" });
  expect(status).toEqual({
    provider: "claude-code",
    state: "logged_in",
    account: {
      maskedLabel: expect.not.stringContaining("someone.long@example.com"),
      planLabel: "max",
      methodLabel: "claude.ai",
    },
  });
  expect(status.account?.maskedLabel).toContain("@example.com");
});

test("reads a signed-out account and an unreadable answer", async () => {
  const out = adapterWith(new FakeAuthProcess(), JSON.stringify({ loggedIn: false }));
  expect(await out.adapter.readStatus({ workingDirectory: "/tmp" })).toEqual({
    provider: "claude-code",
    state: "logged_out",
  });
  const garbled = adapterWith(new FakeAuthProcess(), "not json");
  expect(await garbled.adapter.readStatus({ workingDirectory: "/tmp" })).toEqual({
    provider: "claude-code",
    state: "unknown",
  });
});

test("an executable that cannot start is reported as not installed", async () => {
  const adapter = new ClaudeRuntimeAuthAdapter({
    create: () => {
      throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    },
  });
  expect(await adapter.readStatus({ workingDirectory: "/tmp" })).toEqual({
    provider: "claude-code",
    state: "unavailable",
    unavailableReason: "not_installed",
  });
});

test("login surfaces the authorization link, takes the pasted code and signs in", async () => {
  const login = new FakeAuthProcess();
  const { adapter, commands } = adapterWith(login);
  const events: RuntimeAuthLoginEvent[] = [];
  const secrets: string[] = [];
  const result = adapter.startLogin(
    { workingDirectory: "/tmp", timeoutMs: 2_000, onSecret: (secret) => secrets.push(secret) },
    {
      onEvent: (event) => events.push(event),
      prompt: async () => " abc-123\n",
    },
  );
  login.say(`Opening browser to sign in…\nIf the browser didn't open, visit: ${OAUTH_URL}\n`);
  login.say("Paste code here if prompted > ");
  await Bun.sleep(20);
  expect(events).toEqual([
    {
      kind: "auth_url",
      verificationUrl: OAUTH_URL,
      instructions: "Open this URL and sign in; if the page then shows a code, paste it back.",
    },
    { kind: "code_prompt", message: expect.any(String) },
  ]);
  expect(login.written).toEqual(["abc-123\n"]);
  expect(secrets).toEqual(["abc-123"]);
  login.finish(0);
  await expect(result).resolves.toMatchObject({
    status: "logged_in",
    authStatus: { state: "logged_in", account: { planLabel: "max" } },
  });
  expect(commands).toContainEqual(["claude", "auth", "login"]);
});

test("login refuses a link that does not point at an Anthropic host and stops at once", async () => {
  const login = new FakeAuthProcess();
  const { adapter } = adapterWith(login);
  const events: RuntimeAuthLoginEvent[] = [];
  const result = adapter.startLogin(
    { workingDirectory: "/tmp", timeoutMs: 2_000 },
    { onEvent: (event) => events.push(event), prompt: async () => "x" },
  );
  login.say("If the browser didn't open, visit: https://evil.example/oauth/authorize?state=1\n");
  await expect(result).resolves.toMatchObject({ status: "failed", reason: "process_failed" });
  expect(events).toEqual([]);
  expect(login.killed).toBe(true);
});

test("the link and prompt are found when split across chunks and escape sequences", async () => {
  const login = new FakeAuthProcess();
  const { adapter } = adapterWith(login);
  const events: RuntimeAuthLoginEvent[] = [];
  const result = adapter.startLogin(
    { workingDirectory: "/tmp", timeoutMs: 2_000 },
    { onEvent: (event) => events.push(event), prompt: async () => "code" },
  );
  login.say("\u001b[");
  login.say(`1mIf the browser didn't open, visit: ${OAUTH_URL.slice(0, 30)}`);
  login.say(`${OAUTH_URL.slice(30)}\u001b[0m\nPaste code`);
  login.say(" here if prompted > ");
  await Bun.sleep(20);
  expect(events[0]).toMatchObject({ kind: "auth_url", verificationUrl: OAUTH_URL });
  expect(login.written).toEqual(["code\n"]);
  login.finish(0);
  await result;
});

test("a pasted code that cannot be used ends the login at once so another can start", async () => {
  const login = new FakeAuthProcess();
  const { adapter } = adapterWith(login);
  const result = adapter.startLogin(
    { workingDirectory: "/tmp", timeoutMs: 5_000 },
    {
      onEvent: () => {},
      prompt: async () => {
        throw new Error("the dialog was closed");
      },
    },
  );
  login.say(`If the browser didn't open, visit: ${OAUTH_URL}\nPaste code here if prompted > `);
  await expect(result).resolves.toMatchObject({ status: "failed", reason: "interaction_failed" });
  expect(login.killed).toBe(true);
  expect(adapter.activeOperationId).toBeUndefined();
});

test("a listener that throws ends the login as an interaction failure", async () => {
  const login = new FakeAuthProcess();
  const { adapter } = adapterWith(login);
  const result = adapter.startLogin(
    { workingDirectory: "/tmp", timeoutMs: 5_000 },
    {
      onEvent: () => {
        throw new Error("socket closed");
      },
      prompt: async () => "x",
    },
  );
  login.say(`If the browser didn't open, visit: ${OAUTH_URL}\n`);
  await expect(result).resolves.toMatchObject({ status: "failed", reason: "interaction_failed" });
});

test("a failed login is not reported as signed in because an earlier login is still valid", async () => {
  const login = new FakeAuthProcess();
  const { adapter } = adapterWith(login); // status still says logged in
  const result = adapter.startLogin(
    { workingDirectory: "/tmp", timeoutMs: 2_000 },
    { onEvent: () => {}, prompt: async () => "bad" },
  );
  login.say(`If the browser didn't open, visit: ${OAUTH_URL}\nPaste code here if prompted > `);
  await Bun.sleep(10);
  login.finish(1);
  await expect(result).resolves.toMatchObject({ status: "failed", reason: "rejected" });
});

test("a second login can start once the first has ended", async () => {
  const first = new FakeAuthProcess();
  const { adapter } = adapterWith(first);
  const firstResult = adapter.startLogin(
    { workingDirectory: "/tmp", timeoutMs: 30 },
    { onEvent: () => {}, prompt: async () => "x" },
  );
  await expect(firstResult).resolves.toEqual({ status: "failed", reason: "timed_out" });
  expect(adapter.activeOperationId).toBeUndefined();
  const second = new FakeAuthProcess();
  const next = adapterWith(second);
  const secondResult = next.adapter.startLogin(
    { workingDirectory: "/tmp", timeoutMs: 1_000 },
    { onEvent: () => {}, prompt: async () => "x" },
  );
  second.finish(0);
  await expect(secondResult).resolves.toMatchObject({ status: "logged_in" });
});

test("cancelling by operation id kills the login", async () => {
  const login = new FakeAuthProcess();
  const { adapter } = adapterWith(login);
  const result = adapter.startLogin(
    { workingDirectory: "/tmp", timeoutMs: 5_000 },
    { onEvent: () => {}, prompt: async () => "x" },
  );
  await Bun.sleep(5);
  await adapter.cancel({ operationId: adapter.activeOperationId! });
  await expect(result).resolves.toEqual({ status: "cancelled" });
  expect(login.killed).toBe(true);
});

test("login that never completes times out and kills the process", async () => {
  const login = new FakeAuthProcess();
  const { adapter } = adapterWith(login);
  const result = await adapter.startLogin(
    { workingDirectory: "/tmp", timeoutMs: 50 },
    { onEvent: () => {}, prompt: async () => "x" },
  );
  expect(result).toEqual({ status: "failed", reason: "timed_out" });
  expect(login.killed).toBe(true);
});

test("a rejected code ends the login as rejected", async () => {
  const login = new FakeAuthProcess();
  const { adapter } = adapterWith(login, JSON.stringify({ loggedIn: false }));
  const result = adapter.startLogin(
    { workingDirectory: "/tmp", timeoutMs: 2_000 },
    { onEvent: () => {}, prompt: async () => "bad" },
  );
  login.say(`If the browser didn't open, visit: ${OAUTH_URL}\nPaste code here if prompted > `);
  await Bun.sleep(10);
  login.say("Login failed: invalid code\n");
  login.finish(1);
  await expect(result).resolves.toMatchObject({ status: "failed", reason: "rejected" });
});

test("an abort signal cancels the login", async () => {
  const login = new FakeAuthProcess();
  const { adapter } = adapterWith(login);
  const abort = new AbortController();
  const result = adapter.startLogin(
    { workingDirectory: "/tmp", timeoutMs: 5_000 },
    { onEvent: () => {}, prompt: async () => "x", signal: abort.signal },
  );
  await Bun.sleep(10);
  abort.abort();
  await expect(result).resolves.toEqual({ status: "cancelled" });
  expect(login.killed).toBe(true);
});

test("only one login runs at a time", async () => {
  const login = new FakeAuthProcess();
  const { adapter } = adapterWith(login);
  const first = adapter.startLogin(
    { workingDirectory: "/tmp", timeoutMs: 500 },
    { onEvent: () => {}, prompt: async () => "x" },
  );
  await Bun.sleep(5);
  await expect(
    adapter.startLogin(
      { workingDirectory: "/tmp" },
      { onEvent: () => {}, prompt: async () => "x" },
    ),
  ).resolves.toEqual({ status: "busy" });
  login.finish(1);
  await first;
});

test("logout runs the CLI and reports the signed-out status", async () => {
  const { adapter, commands } = adapterWith(
    new FakeAuthProcess(),
    JSON.stringify({ loggedIn: false }),
  );
  await expect(adapter.logout({ workingDirectory: "/tmp" })).resolves.toEqual({
    status: "logged_out",
    authStatus: { provider: "claude-code", state: "logged_out" },
  });
  expect(commands.map((command) => command.slice(0, 3))).toContainEqual([
    "claude",
    "auth",
    "logout",
  ]);
});

test("logout that leaves the account signed in is reported as failed", async () => {
  const { adapter } = adapterWith(new FakeAuthProcess());
  await expect(adapter.logout({ workingDirectory: "/tmp" })).resolves.toMatchObject({
    status: "failed",
    reason: "still_logged_in",
  });
});

test("a code the CLI rejects is asked for again, and the old code stays redacted", async () => {
  const login = new FakeAuthProcess();
  const { adapter } = adapterWith(login);
  const asked: (string | undefined)[] = [];
  const codes = ["first#state1", "second"];
  const secrets: string[] = [];
  const result = adapter.startLogin(
    { workingDirectory: "/tmp", timeoutMs: 2_000, onSecret: (secret) => secrets.push(secret) },
    {
      onEvent: () => {},
      prompt: async (input) => {
        asked.push(input.message);
        return codes.shift()!;
      },
    },
  );
  login.say(`If the browser didn't open, visit: ${OAUTH_URL}\nPaste code here if prompted >`);
  await Bun.sleep(20);
  login.complain("Invalid code. Please make sure the full code was copied\n");
  await Bun.sleep(20);
  expect(asked[1]).toBe("That code was not accepted. Paste the full code shown after signing in.");
  expect(login.written).toEqual(["first#state1\n", "second\n"]);
  expect(secrets).toEqual(["first#state1", "first", "second"]);
  login.finish(0);
  await expect(result).resolves.toMatchObject({ status: "logged_in" });
});

test("an empty paste is asked for again", async () => {
  const login = new FakeAuthProcess();
  const { adapter } = adapterWith(login);
  const pastes = ["  \n", "real-code"];
  const messages: string[] = [];
  const result = adapter.startLogin(
    { workingDirectory: "/tmp", timeoutMs: 2_000 },
    {
      onEvent: (event) => {
        if (event.kind === "code_prompt") messages.push(event.message);
      },
      prompt: async () => pastes.shift()!,
    },
  );
  login.say("Paste code here if prompted >");
  await Bun.sleep(20);
  expect(messages[1]).toMatch(/No code was entered/u);
  expect(login.written).toEqual(["real-code\n"]);
  login.finish(0);
  await result;
});

test("the code prompt is answered even when it prints before the link", async () => {
  const login = new FakeAuthProcess();
  const { adapter } = adapterWith(login);
  const events: RuntimeAuthLoginEvent[] = [];
  const result = adapter.startLogin(
    { workingDirectory: "/tmp", timeoutMs: 2_000 },
    { onEvent: (event) => events.push(event), prompt: async () => "code" },
  );
  login.say("Paste code here if prompted >");
  await Bun.sleep(10);
  login.say(`If the browser didn't open, visit: ${OAUTH_URL}\n`);
  await Bun.sleep(10);
  expect(events.map((event) => event.kind)).toEqual(["code_prompt", "auth_url"]);
  login.finish(0);
  await result;
});

test("a login failure line is reported in the result", async () => {
  const login = new FakeAuthProcess();
  const { adapter } = adapterWith(login, JSON.stringify({ loggedIn: false }));
  const result = adapter.startLogin(
    { workingDirectory: "/tmp", timeoutMs: 2_000 },
    { onEvent: () => {}, prompt: async () => "x" },
  );
  login.complain("Login failed: account is not eligible\n");
  login.finish(1);
  await expect(result).resolves.toMatchObject({
    status: "failed",
    detail: "account is not eligible",
  });
});

test("a Claude Code older than the paste-back floor is not asked to sign in", async () => {
  const login = new FakeAuthProcess();
  const { adapter, commands } = adapterWith(login, STATUS_IN, "2.1.100 (Claude Code)");
  const result = await adapter.startLogin(
    { workingDirectory: "/tmp", timeoutMs: 200 },
    { onEvent: () => {}, prompt: async () => "x" },
  );
  expect(result).toMatchObject({
    status: "unsupported",
    reason: "version_unsupported",
    detail: expect.stringContaining("2.1.126"),
  });
  expect(commands.some((command) => command[2] === "login")).toBe(false);
});

test("a missing executable is unsupported (not installed) for login and logout", async () => {
  const adapter = new ClaudeRuntimeAuthAdapter({
    create: () => {
      throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    },
  });
  const unsupported = { status: "unsupported", reason: "not_installed" } as const;
  await expect(
    adapter.startLogin({ workingDirectory: "/tmp" }, { onEvent: () => {}, prompt: async () => "" }),
  ).resolves.toEqual(unsupported);
  await expect(adapter.logout({ workingDirectory: "/tmp" })).resolves.toEqual(unsupported);
});

test("a success line with a non-zero exit is confirmed by auth status", async () => {
  const login = new FakeAuthProcess();
  const { adapter } = adapterWith(login); // status reads signed in
  const result = adapter.startLogin(
    { workingDirectory: "/tmp", timeoutMs: 2_000 },
    { onEvent: () => {}, prompt: async () => "code" },
  );
  login.say("Login successful.\n");
  login.finish(1);
  await expect(result).resolves.toMatchObject({ status: "logged_in" });
});

test("a success line is not believed when auth status says signed out", async () => {
  const login = new FakeAuthProcess();
  const { adapter } = adapterWith(login, JSON.stringify({ loggedIn: false }));
  const result = adapter.startLogin(
    { workingDirectory: "/tmp", timeoutMs: 2_000 },
    { onEvent: () => {}, prompt: async () => "code" },
  );
  login.say("Login successful.\n");
  login.finish(0);
  await expect(result).resolves.toMatchObject({ status: "failed" });
});
