import { expect, test } from "bun:test";
import { CommandCodeRuntimeAuthAdapter } from "#src/command-code/auth";

test("Command Code auth status maps cmd status --json without exposing account data", async () => {
  let output = '{"authenticated":false,"version":"1.87.3"}\n';
  let exitCode = 1;
  const adapter = new CommandCodeRuntimeAuthAdapter({
    runStatus: async () => ({ output, exitCode }),
    runWhoami: async () => ({ output: "", exitCode: 1 }),
    maskAccountLabel: (value) => `masked:${value}`,
  });
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

test("Command Code auth status shows the masked whoami email for a logged-in account", async () => {
  const status = {
    output: '{"authenticated":true,"user":{"name":"frank"},"version":"1.87.3"}\n',
    exitCode: 0,
  };
  const masked: string[] = [];
  const adapter = new CommandCodeRuntimeAuthAdapter({
    runStatus: async () => status,
    runWhoami: async () => ({ output: "Email: frank@example.com\n", exitCode: 0 }),
    maskAccountLabel: (value) => {
      masked.push(value);
      return value.includes("@") ? `${value.slice(0, 3)}****@example.com` : undefined;
    },
  });
  await expect(adapter.readStatus({ workingDirectory: "/tmp" })).resolves.toEqual({
    provider: "command-code",
    state: "logged_in",
    account: { maskedLabel: "fra****@example.com" },
  });
  expect(masked).toEqual(["frank@example.com"]);
});

test("Command Code whoami strips ANSI color before parsing the Email line", async () => {
  const adapter = new CommandCodeRuntimeAuthAdapter({
    runStatus: async () => ({
      output: '{"authenticated":true,"user":{"name":"amy"},"version":"1.87.3"}\n',
      exitCode: 0,
    }),
    runWhoami: async () => ({
      output: "\u001b[32mAccount\u001b[0m\n\u001b[36mEmail: amy@example.com\u001b[0m\n",
      exitCode: 0,
    }),
    maskAccountLabel: (value) => `${value.slice(0, 3)}****@example.com`,
  });
  await expect(adapter.readStatus({ workingDirectory: "/tmp" })).resolves.toEqual({
    provider: "command-code",
    state: "logged_in",
    account: { maskedLabel: "amy****@example.com" },
  });
});

test("Command Code whoami runs once per signed-in account, again when the account changes", async () => {
  const status = {
    output: '{"authenticated":true,"user":{"name":"frank"},"version":"1.87.3"}\n',
    exitCode: 0,
  };
  let whoamiCalls = 0;
  const adapter = new CommandCodeRuntimeAuthAdapter({
    runStatus: async () => status,
    runWhoami: async () => {
      whoamiCalls += 1;
      return { output: "Email: frank@example.com\n", exitCode: 0 };
    },
    maskAccountLabel: (value) => `${value.slice(0, 3)}****@example.com`,
  });
  await adapter.readStatus({ workingDirectory: "/tmp" });
  await adapter.readStatus({ workingDirectory: "/tmp" });
  expect(whoamiCalls).toBe(1);
  status.output = '{"authenticated":true,"user":{"name":"amy"},"version":"1.87.3"}\n';
  await adapter.readStatus({ workingDirectory: "/tmp" });
  expect(whoamiCalls).toBe(2);
});

test("Command Code status without a user field still logs in and labels from whoami", async () => {
  const adapter = new CommandCodeRuntimeAuthAdapter({
    runStatus: async () => ({ output: '{"authenticated":true,"version":"1.87.3"}\n', exitCode: 0 }),
    runWhoami: async () => ({ output: "Email: nouser@example.com\n", exitCode: 0 }),
    maskAccountLabel: (value) => `${value.slice(0, 3)}****@example.com`,
  });
  await expect(adapter.readStatus({ workingDirectory: "/tmp" })).resolves.toEqual({
    provider: "command-code",
    state: "logged_in",
    account: { maskedLabel: "nou****@example.com" },
  });
});

test("Command Code whoami failure falls back to the status user and never fails the read", async () => {
  const adapter = new CommandCodeRuntimeAuthAdapter({
    runStatus: async () => ({
      output: '{"authenticated":true,"user":{"name":"amy@example.com"},"version":"1.87.3"}\n',
      exitCode: 0,
    }),
    runWhoami: async () => ({ output: "", exitCode: 1 }),
    maskAccountLabel: (value) => `${value.slice(0, 3)}****@example.com`,
  });
  await expect(adapter.readStatus({ workingDirectory: "/tmp" })).resolves.toEqual({
    provider: "command-code",
    state: "logged_in",
    account: { maskedLabel: "amy****@example.com" },
  });
});

test("Command Code retries whoami after an unparseable lookup instead of caching the fallback", async () => {
  let whoamiCalls = 0;
  const adapter = new CommandCodeRuntimeAuthAdapter({
    runStatus: async () => ({
      output: '{"authenticated":true,"user":{"name":"amy@example.com"},"version":"1.87.3"}\n',
      exitCode: 0,
    }),
    runWhoami: async () => {
      whoamiCalls += 1;
      return whoamiCalls === 1
        ? { output: "Account details unavailable\n", exitCode: 0 }
        : { output: "Email: amy@example.com\n", exitCode: 0 };
    },
    maskAccountLabel: (value) => `${value.slice(0, 3)}****@example.com`,
  });

  await expect(adapter.readStatus({ workingDirectory: "/tmp" })).resolves.toEqual({
    provider: "command-code",
    state: "logged_in",
    account: { maskedLabel: "amy****@example.com" },
  });
  await expect(adapter.readStatus({ workingDirectory: "/tmp" })).resolves.toEqual({
    provider: "command-code",
    state: "logged_in",
    account: { maskedLabel: "amy****@example.com" },
  });
  expect(whoamiCalls).toBe(2);
});

test("Command Code auth caches whoami per adapter instead of sharing across tests or runtimes", async () => {
  let firstCalls = 0;
  let secondCalls = 0;
  const status = {
    output: '{"authenticated":true,"user":{"name":"isolated@example.com"},"version":"1.87.3"}\n',
    exitCode: 0,
  };
  const host = (increment: () => void) => ({
    runStatus: async () => status,
    runWhoami: async () => {
      increment();
      return { output: "Email: isolated@example.com\n", exitCode: 0 };
    },
    maskAccountLabel: (value: string) => `${value.slice(0, 3)}****@example.com`,
  });

  const first = new CommandCodeRuntimeAuthAdapter(host(() => (firstCalls += 1)));
  const second = new CommandCodeRuntimeAuthAdapter(host(() => (secondCalls += 1)));
  await first.readStatus({ workingDirectory: "/tmp" });
  await second.readStatus({ workingDirectory: "/tmp" });
  expect(firstCalls).toBe(1);
  expect(secondCalls).toBe(1);
});

test("Command Code whoami receives only the remaining auth status deadline", async () => {
  let whoamiTimeout = 0;
  const adapter = new CommandCodeRuntimeAuthAdapter({
    runStatus: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { output: '{"authenticated":true,"user":{"name":"amy"}}', exitCode: 0 };
    },
    runWhoami: async (_cwd, timeoutMs) => {
      whoamiTimeout = timeoutMs;
      return { output: "Email: amy@example.com\n", exitCode: 0 };
    },
    maskAccountLabel: (value) => `${value.slice(0, 3)}****@example.com`,
  });

  await adapter.readStatus({ workingDirectory: "/tmp", timeoutMs: 40 });
  expect(whoamiTimeout).toBeGreaterThan(0);
  expect(whoamiTimeout).toBeLessThan(40);
});

test("Command Code auth never starts browser login from the adapter", async () => {
  const adapter = new CommandCodeRuntimeAuthAdapter({
    runStatus: async () => ({ output: "", exitCode: 1 }),
    runWhoami: async () => ({ output: "", exitCode: 1 }),
    maskAccountLabel: () => undefined,
  });
  await expect(
    adapter.startLogin({ workingDirectory: "/tmp" }, { onEvent() {}, prompt: async () => "" }),
  ).resolves.toMatchObject({ status: "unsupported" });
  await expect(adapter.logout({ workingDirectory: "/tmp" })).resolves.toMatchObject({
    status: "unsupported",
  });
});
