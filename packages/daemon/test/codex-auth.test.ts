import { expect, test } from "bun:test";
import { CodexRuntimeAuthAdapter, type CodexAppServerProcess } from "#src/code-agent/codex/auth";

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

test("streams Codex device code and matches completion notification", async () => {
  const process = new FakeProcess();
  const adapter = new CodexRuntimeAuthAdapter({ create: () => process });
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
    authStatus: { accountLabel: "user@example.com", plan: "pro" },
  });
  expect(events).toHaveLength(2);
  expect(process.disposed).toBe(true);
});

test("enforces the minimum Codex version", async () => {
  const adapter = new CodexRuntimeAuthAdapter({
    version: "0.117.9",
    create: () => new FakeProcess(),
  });
  await expect(
    adapter.startLogin({ workingDirectory: "/tmp" }, { onEvent() {}, prompt: async () => "" }),
  ).resolves.toMatchObject({ status: "failed", reason: "process_failed" });
});

test("reports an empty account as not logged in", async () => {
  const process = new FakeProcess();
  process.account = undefined;
  const adapter = new CodexRuntimeAuthAdapter({ create: () => process });
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
  const adapter = new CodexRuntimeAuthAdapter({ create: () => process });
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
  const adapter = new CodexRuntimeAuthAdapter({ create: () => process });
  const first = adapter.startLogin(
    { workingDirectory: "/tmp", timeoutMs: 20 },
    { onEvent() {}, prompt: async () => "" },
  );
  await expect(
    adapter.startLogin({ workingDirectory: "/tmp" }, { onEvent() {}, prompt: async () => "" }),
  ).resolves.toMatchObject({ status: "failed", reason: "rejected" });
  await expect(first).resolves.toMatchObject({ status: "failed", reason: "timed_out" });
});

test("returns cancelled when the interaction signal aborts", async () => {
  const process = new FakeProcess();
  const adapter = new CodexRuntimeAuthAdapter({ create: () => process });
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
    new CodexRuntimeAuthAdapter({ create: () => process }).startLogin(
      { workingDirectory: "/tmp" },
      { onEvent: (event) => events.push(event), prompt: async () => "" },
    ),
  ).resolves.toMatchObject({ status: "logged_in" });
  expect(events).toEqual([]);
});

test("classifies an exited app-server with its exit code", async () => {
  const process = new FakeProcess();
  process.exitCode = 7;
  const adapter = new CodexRuntimeAuthAdapter({ create: () => process });
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
  const login = new CodexRuntimeAuthAdapter({ create: () => process }).startLogin(
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
  const login = new CodexRuntimeAuthAdapter({ create: () => process }).startLogin(
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
  const adapter = new CodexRuntimeAuthAdapter({ create: () => process, accountReadTimeoutMs: 1 });
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
