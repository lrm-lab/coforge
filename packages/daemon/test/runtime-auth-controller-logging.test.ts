import { expect, test } from "bun:test";
import type { RuntimeAuthAdapter } from "@lrm/coforge-anvil";
import type { RuntimeAuthLoginReport } from "@lrm/coforge-sdk/internal";
import { RuntimeAuthController } from "#src/daemon-runtime/runtime-auth-controller";
import { captureDaemonLogs } from "./log-capture";

const scope = { protocolMajor: 1 as const, workspaceId: "workspace-a", computerId: "computer-a" };
const loginId = "rtl_abcdefghijklmnop";

test("logs each accepted intent and the login's terminal outcome without secrets", async () => {
  const reports: RuntimeAuthLoginReport[] = [];
  const adapter: RuntimeAuthAdapter = {
    provider: "codex",
    startLogin: async () => ({
      status: "logged_in",
      authStatus: { provider: "codex", state: "logged_in" },
    }),
    readStatus: async () => ({ provider: "codex", state: "logged_out" }),
    submitCode: async () => {
      throw new Error("Use interaction.prompt");
    },
    cancel: async () => {
      throw new Error("Use interaction.signal");
    },
    logout: async () => ({
      status: "logged_out",
      authStatus: { provider: "codex", state: "logged_out" },
    }),
  };
  const controller = new RuntimeAuthController({
    owner: scope,
    workingDirectory: "/fixture",
    createAdapter: () => adapter,
    reportLogin: async (report) => {
      reports.push(report);
    },
    reportLogout: async () => {},
    refresh: async () => {},
  });
  const { records } = await captureDaemonLogs(async () => {
    await controller.handle({ ...scope, kind: "login_start", loginId, provider: "codex" });
    await controller.handle({ ...scope, kind: "login_code", loginId, code: "ABCD-EFGH" });
    await controller.handle({ ...scope, kind: "status_read", provider: "codex" });
  });
  const intents = records.filter((record) => record.properties.event === "runtime_auth:intent");
  expect(intents.map((record) => record.properties)).toMatchObject([
    { kind: "login_start", provider: "codex", login_id: loginId },
    { kind: "login_code", login_id: loginId },
    { kind: "status_read", provider: "codex" },
  ]);
  expect(JSON.stringify(records)).not.toContain("ABCD-EFGH");
  expect(
    records
      .filter((record) => record.properties.event === "runtime_auth:login_finished")
      .map((record) => record.properties),
  ).toMatchObject([{ provider: "codex", login_id: loginId, outcome: "logged_in" }]);
});
