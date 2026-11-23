import { expect, test } from "bun:test";
import type { ManagedRuntimeIdentity } from "@lrm/coforge-sdk/internal";
import {
  assertSupervisorRestartTarget,
  assertWorkspaceRestartTarget,
} from "#src/cli/restart-target-guard";
import { verifyRestartServiceTarget } from "#src/cli/restart-service-target";
import { createCommand } from "#src/daemon-client/index";
import { runCli } from "#src/cli";

const caller = { workspaceId: "shared", computerId: "current-computer" };
const binding: ManagedRuntimeIdentity = {
  ...caller,
  enabled: true,
  instanceId: "invocation",
  processId: 42,
  version: "test",
};

test("the default restart skips a disabled hosting binding, but a scoped restart targets it", async () => {
  const read = async () => [{ ...binding, enabled: false }];
  await expect(assertWorkspaceRestartTarget(caller, undefined, read)).resolves.toBeUndefined();
  await expect(
    assertWorkspaceRestartTarget(caller, caller.workspaceId, read),
  ).rejects.toMatchObject({
    code: "RESTART_HOSTING_AGENT_SESSION",
  });
});

test("an explicit non-hosting Workspace remains usable if the snapshot is unavailable", async () => {
  const unavailable = async () => {
    throw new Error("no Coordinator response");
  };
  await expect(assertWorkspaceRestartTarget(caller, "other", unavailable)).resolves.toBeUndefined();
  await expect(assertWorkspaceRestartTarget(caller, undefined, unavailable)).rejects.toMatchObject({
    code: "RESTART_TARGET_UNVERIFIED",
  });
});

test("absence of an active Computer ID cannot prove a distinct installation", async () => {
  const read = async () => [{ ...binding, computerId: "" }];
  await expect(
    assertWorkspaceRestartTarget(caller, caller.workspaceId, read),
  ).rejects.toMatchObject({
    code: "RESTART_HOSTING_AGENT_SESSION",
  });
});

test("a supervisor hosting another binding of the same Computer remains protected", async () => {
  const read = async () => ({
    bindings: [{ ...binding, workspaceId: "other" }],
    coordinatorPid: 100,
  });
  const verifyService = async () => {
    throw new Error("The platform manager must not be called");
  };
  await expect(assertSupervisorRestartTarget(caller, read, verifyService)).rejects.toMatchObject({
    code: "RESTART_TARGET_UNVERIFIED",
  });
});

test("Windows cannot verify the running task from a foreign socket's PID alone", async () => {
  await expect(
    verifyRestartServiceTarget({
      platform: "win32",
      stateDirectory: "/unused",
      coordinatorPid: 200,
    }),
  ).resolves.toBe(false);
});

test("restart reports the guarded resolved binding before ensuring or restarting the daemon", async () => {
  const calls: string[] = [];
  const client = createCommand({
    daemon: {
      async ensureRunning() {
        calls.push("ensure");
      },
      async isRunning() {
        return true;
      },
      async command(operation, target) {
        calls.push([operation, target].join(" "));
        return [];
      },
    },
    resolveWorkspace: async (slug) => ({ id: "shared", slug }),
    assertRestartTarget: (target) =>
      assertWorkspaceRestartTarget(caller, target, async () => [binding]),
  });
  const dependencies = {
    login: { async run() {} },
    setup: { async run() {} },
    daemon: {
      ...client,
      async restart(workspace?: string) {
        await client.restart(workspace);
      },
    },
  };
  const out: string[] = [];
  const err: string[] = [];
  const io = { stdout: (line: string) => out.push(line), stderr: (line: string) => err.push(line) };
  const args = ["restart", "--workspace", "alpha"];
  expect(await runCli(args, dependencies, io)).toBe(1);
  expect(err.pop()).toContain("normal terminal outside this Agent session");
  expect(await runCli([...args, "--json"], dependencies, io)).toBe(1);
  expect(JSON.parse(out[0]!)).toMatchObject({
    ok: false,
    error: {
      code: "RESTART_HOSTING_AGENT_SESSION",
      hint: expect.stringContaining("normal terminal"),
    },
  });
  expect(err).toEqual([]);
  expect(calls).toEqual([]);
});
