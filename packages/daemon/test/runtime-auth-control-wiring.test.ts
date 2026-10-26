import { captureDaemonLogs } from "./log-capture";
import { expect, test } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeAuthAdapter } from "@lrm/coforge-anvil";
import {
  RUNTIME_AUTH_CAPABILITY,
  KIRO_IDENTITY_CENTER_AUTH_CAPABILITY,
  type RuntimeAuthIntent,
  type RuntimeAuthLoginReport,
} from "@lrm/coforge-sdk/internal";
import { DaemonRuntime } from "#src/daemon-runtime/runtime";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";

test("the runtime advertises auth only with a registered handler and refreshes status after a login", async () => {
  const directory = await mkdtemp(join(realpathSync(tmpdir()), "coforge-auth-control-"));
  const owner = { computerId: "computer-a", workspaceId: "workspace-a", workspaceRoot: directory };
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(owner.workspaceId, owner.computerId, "fixture-token");
  let receiver: ((intent: RuntimeAuthIntent) => void) | undefined;
  let readyCapabilities: string[] = [];
  const initial = Promise.withResolvers<void>();
  const refreshed = Promise.withResolvers<void>();
  const terminal = Promise.withResolvers<RuntimeAuthLoginReport>();
  let statusReports = 0;
  let starts = 0;
  const adapter: RuntimeAuthAdapter = {
    provider: "codex",
    async startLogin() {
      starts++;
      return {
        status: "logged_in",
        authStatus: {
          provider: "codex",
          state: "logged_in",
          account: { maskedLabel: "u****@example.com" },
        },
      };
    },
    async readStatus() {
      return { provider: "codex", state: "logged_out" };
    },
    async submitCode() {},
    async cancel() {},
    async logout() {
      return { status: "logged_out", authStatus: { provider: "codex", state: "logged_out" } };
    },
  };
  const runtime = new DaemonRuntime(
    owner,
    () => {
      throw new Error("No Agent expected");
    },
    credentials,
    {
      create: () => ({
        async start() {},
        async stop() {},
        async ready(createRequest) {
          readyCapabilities = createRequest().capabilities ?? [];
          expect(receiver).toBeFunction();
        },
        async updateCodeAgents() {},
        onRuntimeAuth(callback) {
          receiver = callback;
          return () => {
            receiver = undefined;
          };
        },
        async reportRuntimeAuthLogin(report) {
          terminal.resolve(report);
        },
        async reportRuntimeAuthLogout() {},
        async reportRuntimeAuthStatus() {
          if (++statusReports === 1) initial.resolve();
          else refreshed.resolve();
        },
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
    join(directory, "state"),
    {},
    undefined,
    {},
    () => adapter,
  );
  try {
    await runtime.start(owner);
    await initial.promise;
    expect(readyCapabilities).toContain(RUNTIME_AUTH_CAPABILITY);
    expect(readyCapabilities.includes(KIRO_IDENTITY_CENTER_AUTH_CAPABILITY)).toBe(
      process.platform === "darwin" || process.platform === "linux",
    );
    receiver!({
      protocolMajor: 1,
      ...owner,
      kind: "login_start",
      loginId: "rtl_abcdefghijklmnop",
      provider: "codex",
    });
    expect((await terminal.promise).result).toEqual({
      kind: "logged_in",
      account: { maskedLabel: "u****@example.com" },
    });
    await refreshed.promise;
    expect(starts).toBe(1);
    await runtime.stop();
    expect(receiver).toBeUndefined();
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("pasted codes and provider error traces never enter logs, Activity or local trace files", async () => {
  const directory = await mkdtemp(join(realpathSync(tmpdir()), "coforge-auth-private-"));
  const owner = { computerId: "computer-a", workspaceId: "workspace-a", workspaceRoot: directory };
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(owner.workspaceId, owner.computerId, "fixture-token");
  let receiver: ((intent: RuntimeAuthIntent) => void) | undefined;
  const waiting = Promise.withResolvers<void>();
  const terminal = Promise.withResolvers<RuntimeAuthLoginReport>();
  const activity: unknown[] = [];
  const outputs: unknown[] = [];
  const providerSecret = "provider-sentinel-129";
  const pastedCode = "pasted-sentinel-129#state-sentinel-129";
  const adapter: RuntimeAuthAdapter = {
    provider: "claude-code",
    async startLogin(options, interaction) {
      options.onSecret?.(providerSecret);
      const prompt = interaction.prompt({ kind: "manual_code", message: "Paste code" });
      waiting.resolve();
      await prompt;
      throw Object.assign(new Error(`${providerSecret} ${pastedCode}`), {
        trace: { raw: pastedCode },
      });
    },
    async readStatus() {
      return { provider: "claude-code", state: "logged_out" };
    },
    async submitCode() {},
    async cancel() {},
    async logout() {
      return { status: "logged_out", authStatus: { provider: "claude-code", state: "logged_out" } };
    },
  };
  const runtime = new DaemonRuntime(
    owner,
    () => {
      throw new Error("Auth must not launch an Agent");
    },
    credentials,
    {
      create: () => ({
        async start() {},
        async stop() {},
        async ready() {},
        async updateCodeAgents() {},
        onRuntimeAuth(callback) {
          receiver = callback;
          return () => {
            receiver = undefined;
          };
        },
        async reportRuntimeAuthLogin(report) {
          outputs.push(report);
          if (report.result) terminal.resolve(report);
        },
        async reportRuntimeAuthLogout(report) {
          outputs.push(report);
        },
        async reportRuntimeAuthStatus(report) {
          outputs.push(report);
        },
        sendAgentActivity(value) {
          activity.push(value);
        },
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
    join(directory, "state"),
    {},
    undefined,
    {},
    () => adapter,
  );
  try {
    const { records } = await captureDaemonLogs(async () => {
      await runtime.start(owner);
      const login = { protocolMajor: 1 as const, ...owner, loginId: "rtl_abcdefghijklmnop" };
      receiver!({ ...login, kind: "login_start", provider: "claude-code" });
      await waiting.promise;
      receiver!({ ...login, kind: "login_code", code: pastedCode });
      expect((await terminal.promise).result).toEqual({ kind: "failed", reason: "process_failed" });
      await runtime.stop();
    });
    expect(activity).toEqual([]);
    const files = await readdir(directory, { recursive: true, withFileTypes: true });
    const traces = await Promise.all(
      files
        .filter((file) => file.isFile())
        .map((file) => Bun.file(join(file.parentPath, file.name)).text()),
    );
    for (const output of [
      JSON.stringify(records),
      JSON.stringify(activity),
      JSON.stringify(outputs),
      ...traces,
    ]) {
      expect(output).not.toContain(providerSecret);
      expect(output).not.toContain("pasted-sentinel-129");
      expect(output).not.toContain("state-sentinel-129");
    }
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
