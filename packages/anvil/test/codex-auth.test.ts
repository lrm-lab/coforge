import { fixtureCodexAuthHost } from "./fixtures/codex-host";
import { captureDaemonLogs } from "./fixtures/log-capture";
import { expect, test } from "bun:test";
import {
  CodexRuntimeAuthAdapter,
  type CodexAppServerProcess,
  type CodexCliRunner,
} from "@lrm/coforge-anvil/codex";

class FakeProcess implements CodexAppServerProcess {
  readonly records = new Set<(record: Readonly<Record<string, unknown>>) => void>();
  readonly failures = new Set<(error: Error) => void>();
  disposed = false;
  exitCode: number | undefined;
  account: Record<string, unknown> | undefined = { email: "user@example.com", planType: "pro" };
  async request(command: Readonly<Record<string, unknown>>) {
    if (command.method === "account/login/start")
      return {
        result: {
          loginId: "login-1",
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "ABCD-EFGH",
        },
      };
    if (command.method === "account/read")
      return { result: this.account ? { account: this.account } : {} };
    return { result: {} };
  }
  async send() {}
  onRecord(listener: (record: Readonly<Record<string, unknown>>) => void) {
    this.records.add(listener);
    return () => this.records.delete(listener);
  }
  onFailure(listener: (error: Error) => void) {
    this.failures.add(listener);
    return () => this.failures.delete(listener);
  }
  async dispose() {
    this.disposed = true;
  }
  emit(record: Readonly<Record<string, unknown>>) {
    for (const listener of this.records) listener(record);
  }
  fail(error = new Error("closed")) {
    for (const listener of this.failures) listener(error);
  }
}

test.each(["text", "stderr"] as const)("reads successful Codex status from %s", async (stream) => {
  for (const method of ["ChatGPT", "an API key"]) {
    const result = await new CodexRuntimeAuthAdapter({
      host: fixtureCodexAuthHost,
      runCli: async () => ({ text: "", [stream]: `Logged in using ${method}\n`, exitCode: 0 }),
    }).readStatus({ workingDirectory: "/fixture" });
    expect(result).toEqual({
      provider: "codex",
      state: "logged_in",
      account: { methodLabel: method },
    });
  }
});

test.each(["", "Logged in using workload identity", "API key configured - masked"])(
  "accepts successful Codex status without a recognized method: %j",
  async (stderr) => {
    const result = await new CodexRuntimeAuthAdapter({
      host: fixtureCodexAuthHost,
      runCli: async () => ({ text: "", stderr, exitCode: 0 }),
    }).readStatus({ workingDirectory: "/fixture" });
    expect(result).toEqual({ provider: "codex", state: "logged_in" });
  },
);

test.each(["text", "stderr"] as const)("reads logged-out Codex status from %s", async (stream) => {
  const result = await new CodexRuntimeAuthAdapter({
    host: fixtureCodexAuthHost,
    runCli: async () => ({
      text: "",
      [stream]: "Warning: configuration notice\nNot logged in\n",
      exitCode: 1,
    }),
  }).readStatus({ workingDirectory: "/fixture" });
  expect(result).toEqual({ provider: "codex", state: "logged_out" });
});

test.each([
  { text: "Not logged in", exitCode: 2 },
  { text: "Not logged ineligible", exitCode: 1 },
  { text: "Error: Not logged in", exitCode: 1 },
  { text: "Logged in using ChatGPT", exitCode: 1 },
  { text: "", stderr: "Error checking login status", exitCode: 1 },
  { text: "", exitCode: -1, timedOut: true },
])("keeps inconclusive Codex status unknown: %j", async (output) => {
  const result = await new CodexRuntimeAuthAdapter({
    host: fixtureCodexAuthHost,
    runCli: async () => output,
  }).readStatus({
    workingDirectory: "/fixture",
  });
  expect(result).toEqual({ provider: "codex", state: "unknown" });
});

test("logs only the redacted last diagnostic line for unknown Codex status", async () => {
  const { result, records } = await captureDaemonLogs(async () => {
    return await new CodexRuntimeAuthAdapter({
      host: fixtureCodexAuthHost,
      runCli: async () => ({
        text: "Earlier stdout diagnostic",
        stderr:
          "Earlier stderr diagnostic\nError: token=private-value Bearer private-bearer sk-private-key\n\n",
        exitCode: 2,
      }),
    }).readStatus({ workingDirectory: "/fixture" });
  });
  expect(result).toEqual({ provider: "codex", state: "unknown" });
  expect(records).toHaveLength(1);
  expect(records[0]!.level).toBe("info");
  expect(records[0]!.properties).toEqual({
    exitCode: 2,
    detail: "Error: token=[REDACTED] Bearer [REDACTED] [REDACTED]",
  });
});

test("streams Codex device code and matches completion notification", async () => {
  const process = new FakeProcess();
  const adapter = new CodexRuntimeAuthAdapter({
    host: fixtureCodexAuthHost,
    create: () => process,
  });
  const events: unknown[] = [];
  const login = adapter.startLogin(
    { workingDirectory: "/tmp", timeoutMs: 1000 },
    { onEvent: (event) => events.push(event), prompt: async () => "" },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  process.emit({
    method: "account/login/completed",
    params: { loginId: "login-1", success: true },
  });
  await expect(login).resolves.toMatchObject({
    status: "logged_in",
    authStatus: { account: { maskedLabel: "u****@example.com", planLabel: "pro" } },
  });
  expect(events).toHaveLength(2);
  expect(process.disposed).toBe(true);
});

test("enforces the minimum Codex version", async () => {
  const adapter = new CodexRuntimeAuthAdapter({
    host: fixtureCodexAuthHost,
    version: "0.117.9",
    create: () => new FakeProcess(),
  });
  await expect(
    adapter.startLogin({ workingDirectory: "/tmp" }, { onEvent() {}, prompt: async () => "" }),
  ).resolves.toMatchObject({ status: "unsupported", reason: "version_unsupported" });
});

test("reports an empty account as not logged in", async () => {
  const process = new FakeProcess();
  process.account = undefined;
  const adapter = new CodexRuntimeAuthAdapter({
    host: fixtureCodexAuthHost,
    create: () => process,
  });
  const login = adapter.startLogin(
    { workingDirectory: "/tmp", timeoutMs: 1000 },
    { onEvent() {}, prompt: async () => "" },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  process.emit({
    method: "account/login/completed",
    params: { loginId: "login-1", success: true },
  });
  await expect(login).resolves.toMatchObject({ status: "logged_in" });
});

test("ignores an early completion for a different login id and waits for the matching one", async () => {
  const process = new FakeProcess();
  const adapter = new CodexRuntimeAuthAdapter({
    host: fixtureCodexAuthHost,
    create: () => process,
  });
  const login = adapter.startLogin(
    { workingDirectory: "/tmp", timeoutMs: 20 },
    { onEvent() {}, prompt: async () => "" },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  process.emit({ method: "account/login/completed", params: { loginId: "other", success: true } });
  await expect(login).resolves.toMatchObject({ status: "failed", reason: "timed_out" });
});

test("rejects a duplicate while a login is active", async () => {
  const process = new FakeProcess();
  const adapter = new CodexRuntimeAuthAdapter({
    host: fixtureCodexAuthHost,
    create: () => process,
  });
  const first = adapter.startLogin(
    { workingDirectory: "/tmp", timeoutMs: 20 },
    { onEvent() {}, prompt: async () => "" },
  );
  await expect(
    adapter.startLogin({ workingDirectory: "/tmp" }, { onEvent() {}, prompt: async () => "" }),
  ).resolves.toEqual({ status: "busy" });
  await expect(first).resolves.toMatchObject({ status: "failed", reason: "timed_out" });
});

test("returns cancelled when the interaction signal aborts", async () => {
  const process = new FakeProcess();
  const adapter = new CodexRuntimeAuthAdapter({
    host: fixtureCodexAuthHost,
    create: () => process,
  });
  const controller = new AbortController();
  const login = adapter.startLogin(
    { workingDirectory: "/tmp", timeoutMs: 1000 },
    { onEvent() {}, prompt: async () => "", signal: controller.signal },
  );
  controller.abort();
  await expect(login).resolves.toEqual({ status: "cancelled" });
});

test("does not emit device code when a matching completion arrived before start returned", async () => {
  const process = new FakeProcess();
  const original = process.request.bind(process);
  process.request = async (command) => {
    if (command.method === "account/login/start")
      process.emit({
        method: "account/login/completed",
        params: { loginId: "login-1", success: true },
      });
    return original(command);
  };
  const events: unknown[] = [];
  await expect(
    new CodexRuntimeAuthAdapter({ host: fixtureCodexAuthHost, create: () => process }).startLogin(
      { workingDirectory: "/tmp" },
      { onEvent: (event) => events.push(event), prompt: async () => "" },
    ),
  ).resolves.toMatchObject({ status: "logged_in" });
  expect(events).toEqual([]);
});

test("classifies a login start the app-server answered with an error", async () => {
  const process = new FakeProcess();
  const original = process.request.bind(process);
  process.request = async (command) => {
    if (command.method === "account/login/start") throw new Error("request timed out");
    return original(command);
  };
  await expect(
    new CodexRuntimeAuthAdapter({
      host: fixtureCodexAuthHost,
      create: () => process,
    }).startLogin({ workingDirectory: "/tmp" }, { onEvent() {}, prompt: async () => "" }),
  ).resolves.toEqual({
    status: "failed",
    reason: "rejected",
    detail: "codex_login_start_failed",
  });
  expect(process.disposed).toBe(true);
});

test("classifies an exited app-server with its exit code", async () => {
  const process = new FakeProcess();
  process.exitCode = 7;
  const adapter = new CodexRuntimeAuthAdapter({
    host: fixtureCodexAuthHost,
    create: () => process,
  });
  const login = adapter.startLogin(
    { workingDirectory: "/tmp", timeoutMs: 1000 },
    { onEvent() {}, prompt: async () => "" },
  );
  process.fail();
  await expect(login).resolves.toMatchObject({
    status: "failed",
    reason: "process_failed",
    detail: "codex app-server exited with code 7",
  });
});

test("classifies a failing event sink as interaction_failed", async () => {
  const process = new FakeProcess();
  const login = new CodexRuntimeAuthAdapter({
    host: fixtureCodexAuthHost,
    create: () => process,
  }).startLogin(
    { workingDirectory: "/tmp" },
    {
      onEvent: () => {
        throw new Error("sink failed");
      },
      prompt: async () => "",
    },
  );
  await expect(login).resolves.toMatchObject({ status: "failed", reason: "interaction_failed" });
});

test("returns timed_out when device login exceeds its deadline", async () => {
  const process = new FakeProcess();
  const login = new CodexRuntimeAuthAdapter({
    host: fixtureCodexAuthHost,
    create: () => process,
  }).startLogin(
    { workingDirectory: "/tmp", timeoutMs: 1 },
    { onEvent() {}, prompt: async () => "" },
  );
  await expect(login).resolves.toMatchObject({ status: "failed", reason: "timed_out" });
});

test("keeps a successful login when account/read times out", async () => {
  const process = new FakeProcess();
  const original = process.request.bind(process);
  process.request = async (command) =>
    command.method === "account/read" ? await new Promise<never>(() => {}) : original(command);
  const adapter = new CodexRuntimeAuthAdapter({
    host: fixtureCodexAuthHost,
    create: () => process,
    accountReadTimeoutMs: 1,
  });
  const login = adapter.startLogin(
    { workingDirectory: "/tmp", timeoutMs: 1000 },
    { onEvent() {}, prompt: async () => "" },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  process.emit({
    method: "account/login/completed",
    params: { loginId: "login-1", success: true },
  });
  await expect(login).resolves.toMatchObject({ status: "logged_in" });
});

test("runs codex logout and confirms the account is logged out", async () => {
  const commands: string[][] = [];
  const runCli: CodexCliRunner = async (command) => {
    commands.push([...command]);
    return command.includes("logout")
      ? { exitCode: 0, text: "Logged out" }
      : { exitCode: 1, text: "Not logged in" };
  };
  const result = await new CodexRuntimeAuthAdapter({ host: fixtureCodexAuthHost, runCli }).logout({
    workingDirectory: "/tmp",
  });
  expect(result).toMatchObject({ status: "logged_out", authStatus: { state: "logged_out" } });
  expect(commands).toEqual([
    ["codex", "logout"],
    ["codex", "login", "status"],
  ]);
});

test("reports a failed logout process", async () => {
  const result = await new CodexRuntimeAuthAdapter({
    host: fixtureCodexAuthHost,
    runCli: async () => ({ exitCode: 1, text: "logout failed" }),
  }).logout({ workingDirectory: "/tmp" });
  expect(result).toMatchObject({ status: "failed", reason: "process_failed" });
});

test("confirms logged out even when logout exits unsuccessfully", async () => {
  const result = await new CodexRuntimeAuthAdapter({
    host: fixtureCodexAuthHost,
    runCli: async (command) =>
      command.includes("status")
        ? { exitCode: 1, text: "Not logged in" }
        : { exitCode: 1, text: "", stderr: "already logged out" },
  }).logout({ workingDirectory: "/tmp" });
  expect(result).toMatchObject({ status: "logged_out" });
});

test("treats successful logout with unknown status as logged out", async () => {
  const result = await new CodexRuntimeAuthAdapter({
    host: fixtureCodexAuthHost,
    runCli: async (command) =>
      command.includes("status") ? { exitCode: 2, text: "unexpected" } : { exitCode: 0, text: "" },
  }).logout({ workingDirectory: "/tmp" });
  expect(result).toMatchObject({ status: "logged_out" });
});

test("classifies logout timeout and rejected command", async () => {
  const timedOut = await new CodexRuntimeAuthAdapter({
    host: fixtureCodexAuthHost,
    runCli: async (command) =>
      command.includes("status")
        ? { exitCode: 2, text: "unknown" }
        : { exitCode: -1, text: "", timedOut: true },
  }).logout({ workingDirectory: "/tmp" });
  expect(timedOut).toMatchObject({ status: "failed", reason: "timed_out" });
  const rejected = await new CodexRuntimeAuthAdapter({
    host: fixtureCodexAuthHost,
    runCli: async (command) =>
      command.includes("status")
        ? { exitCode: 2, text: "unknown" }
        : { exitCode: 1, text: "", stderr: "permission denied\n" },
  }).logout({ workingDirectory: "/tmp" });
  expect(rejected).toMatchObject({
    status: "failed",
    reason: "rejected",
    detail: "permission denied",
  });
});

test("uses separate login and logout version floors", async () => {
  let logoutRan = false;
  const adapter = new CodexRuntimeAuthAdapter({
    host: fixtureCodexAuthHost,
    version: "0.100.0",
    runCli: async (command) => {
      logoutRan ||= command.includes("logout");
      return command.includes("status")
        ? { exitCode: 1, text: "Not logged in" }
        : { exitCode: 0, text: "" };
    },
  });
  await expect(
    adapter.startLogin({ workingDirectory: "/tmp" }, { onEvent() {}, prompt: async () => "" }),
  ).resolves.toMatchObject({ status: "unsupported", reason: "version_unsupported" });
  await expect(adapter.logout({ workingDirectory: "/tmp" })).resolves.toMatchObject({
    status: "logged_out",
  });
  expect(logoutRan).toBe(true);
});

test("an already-cancelled login never starts a Codex app-server", async () => {
  let spawned = 0;
  const adapter = new CodexRuntimeAuthAdapter({
    host: fixtureCodexAuthHost,
    create: () => {
      spawned++;
      return new FakeProcess();
    },
  });
  const abort = new AbortController();
  abort.abort();
  const result = await adapter.startLogin(
    { workingDirectory: "/fixture", timeoutMs: 10 },
    { signal: abort.signal, onEvent() {}, prompt: async () => "unused" },
  );
  expect(result).toEqual({ status: "cancelled" });
  expect(spawned).toBe(0);
});
