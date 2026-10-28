import { expect, test } from "bun:test";
import {
  COMMAND_CODE_API_KEY_ENV_DETAIL,
  COMMAND_CODE_BROWSER_UNAVAILABLE_DETAIL,
  CommandCodeRuntimeAuthAdapter,
  type CommandCodeAuthHost,
  type CommandCodeAuthProcess,
} from "#src/command-code/auth";

function fakeProcess(
  chunks: string[],
  exitCode: number,
): CommandCodeAuthProcess & { disposed: boolean } {
  let disposed = false;
  const encoder = new TextEncoder();
  return {
    get disposed() {
      return disposed;
    },
    output: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    exited: Promise.resolve(exitCode),
    async dispose() {
      disposed = true;
    },
  };
}

function hangingProcess(): CommandCodeAuthProcess & { disposed: boolean } {
  let disposed = false;
  return {
    get disposed() {
      return disposed;
    },
    output: new ReadableStream<Uint8Array>({ start() {} }),
    exited: new Promise<number>(() => {}),
    async dispose() {
      disposed = true;
    },
  };
}

function host(overrides: Partial<CommandCodeAuthHost> = {}): CommandCodeAuthHost {
  return {
    runStatus: async () => ({ output: '{"authenticated":true}', exitCode: 0 }),
    spawn: () => fakeProcess([], 0),
    ...overrides,
  };
}

const interaction = { onEvent() {}, prompt: async () => "" };

test("Command Code auth status maps cmd status --json without exposing account data", async () => {
  let output = '{"authenticated":false,"version":"1.87.3"}\n';
  let exitCode = 1;
  const adapter = new CommandCodeRuntimeAuthAdapter(
    host({ runStatus: async () => ({ output, exitCode }) }),
  );
  await expect(adapter.readStatus({ workingDirectory: "/tmp" })).resolves.toEqual({
    provider: "command-code",
    state: "logged_out",
  });
  output = '{"authenticated":true,"user":{"name":"hidden"},"version":"1.87.3"}\n';
  exitCode = 0;
  await expect(adapter.readStatus({ workingDirectory: "/tmp" })).resolves.toEqual({
    provider: "command-code",
    state: "logged_in",
  });
  output = "Run cmd auth login to authenticate.\n";
  exitCode = 1;
  await expect(adapter.readStatus({ workingDirectory: "/tmp" })).resolves.toEqual({
    provider: "command-code",
    state: "unknown",
  });
  output = "unexpected";
  exitCode = 2;
  await expect(adapter.readStatus({ workingDirectory: "/tmp" })).resolves.toEqual({
    provider: "command-code",
    state: "unknown",
  });
});

test("Command Code login reports logged_in once cmd login exits 0 and status confirms it", async () => {
  const adapter = new CommandCodeRuntimeAuthAdapter(
    host({ spawn: () => fakeProcess(["Complete login in your browser...\n"], 0) }),
  );
  await expect(adapter.startLogin({ workingDirectory: "/tmp" }, interaction)).resolves.toEqual({
    status: "logged_in",
    authStatus: { provider: "command-code", state: "logged_in" },
  });
});

test("Command Code login fails as not_logged_in when the flow ends without a session", async () => {
  const adapter = new CommandCodeRuntimeAuthAdapter(
    host({ runStatus: async () => ({ output: '{"authenticated":false}', exitCode: 1 }) }),
  );
  await expect(adapter.startLogin({ workingDirectory: "/tmp" }, interaction)).resolves.toEqual({
    status: "failed",
    reason: "not_logged_in",
  });
});

test("Command Code login kills the process when the CLI falls back to pasting a key", async () => {
  let child: (CommandCodeAuthProcess & { disposed: boolean }) | undefined;
  const adapter = new CommandCodeRuntimeAuthAdapter(
    host({
      spawn: () => {
        child = fakeProcess(["Could not open browser. Paste your API key below.\n"], 0);
        return child;
      },
    }),
  );
  await expect(adapter.startLogin({ workingDirectory: "/tmp" }, interaction)).resolves.toEqual({
    status: "failed",
    reason: "interaction_failed",
    detail: COMMAND_CODE_BROWSER_UNAVAILABLE_DETAIL,
  });
  expect(child?.disposed).toBe(true);
});

test("Command Code login times out and disposes the process", async () => {
  let child: (CommandCodeAuthProcess & { disposed: boolean }) | undefined;
  const adapter = new CommandCodeRuntimeAuthAdapter(
    host({
      spawn: () => {
        child = hangingProcess();
        return child;
      },
    }),
  );
  await expect(
    adapter.startLogin({ workingDirectory: "/tmp", timeoutMs: 10 }, interaction),
  ).resolves.toEqual({ status: "failed", reason: "timed_out" });
  expect(child?.disposed).toBe(true);
});

test("Command Code login cancellation ends the process without waiting for the browser", async () => {
  let child: (CommandCodeAuthProcess & { disposed: boolean }) | undefined;
  const controller = new AbortController();
  const adapter = new CommandCodeRuntimeAuthAdapter(
    host({
      spawn: () => {
        child = hangingProcess();
        return child;
      },
    }),
  );
  const login = adapter.startLogin(
    { workingDirectory: "/tmp" },
    { ...interaction, signal: controller.signal },
  );
  controller.abort();
  await expect(login).resolves.toEqual({ status: "cancelled" });
  expect(child?.disposed).toBe(true);
});

test("Command Code logout runs cmd logout and reports logged_out", async () => {
  let loggedIn = true;
  const adapter = new CommandCodeRuntimeAuthAdapter(
    host({
      spawn: (args) => {
        expect(args).toEqual(["logout"]);
        loggedIn = false;
        return fakeProcess([], 0);
      },
      runStatus: async () =>
        loggedIn
          ? { output: '{"authenticated":true}', exitCode: 0 }
          : { output: '{"authenticated":false}', exitCode: 1 },
    }),
  );
  await expect(adapter.logout({ workingDirectory: "/tmp" })).resolves.toEqual({
    status: "logged_out",
    authStatus: { provider: "command-code", state: "logged_out" },
  });
});

test("Command Code logout reports still_logged_in when an environment key survives logout", async () => {
  const adapter = new CommandCodeRuntimeAuthAdapter(host({ spawn: () => fakeProcess([], 0) }));
  await expect(adapter.logout({ workingDirectory: "/tmp" })).resolves.toEqual({
    status: "failed",
    reason: "still_logged_in",
    detail: COMMAND_CODE_API_KEY_ENV_DETAIL,
  });
});

test("Command Code submitCode is rejected because login completes in the browser", async () => {
  const adapter = new CommandCodeRuntimeAuthAdapter(host());
  await expect(adapter.submitCode()).rejects.toThrow("browser on this machine");
});
