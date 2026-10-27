import { expect, test } from "bun:test";
import { CommandCodeRuntimeAuthAdapter } from "#src/command-code/auth";

test("Command Code auth status maps cmd status --json without exposing account data", async () => {
  let output = '{"authenticated":false,"version":"1.87.3"}\n';
  let exitCode = 1;
  const adapter = new CommandCodeRuntimeAuthAdapter({
    runStatus: async () => ({ output, exitCode }),
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

test("Command Code auth never starts browser login from the adapter", async () => {
  const adapter = new CommandCodeRuntimeAuthAdapter({
    runStatus: async () => ({ output: "", exitCode: 1 }),
  });
  await expect(
    adapter.startLogin({ workingDirectory: "/tmp" }, { onEvent() {}, prompt: async () => "" }),
  ).resolves.toMatchObject({ status: "unsupported" });
  await expect(adapter.logout({ workingDirectory: "/tmp" })).resolves.toMatchObject({
    status: "unsupported",
  });
});
