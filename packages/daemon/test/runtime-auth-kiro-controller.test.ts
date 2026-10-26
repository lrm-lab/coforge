import { expect, test } from "bun:test";
import type { RuntimeAuthAdapter } from "@lrm/coforge-anvil";
import {
  encodeRuntimeAuthLoginReport,
  decodeRuntimeAuthLoginReport,
  type RuntimeAuthLoginReport,
} from "@lrm/coforge-sdk/internal";
import { RuntimeAuthController } from "#src/daemon-runtime/runtime-auth-controller";
test("Kiro enterprise target crosses the controller while a native code without TTL stays without a countdown", async () => {
  const owner = { protocolMajor: 1 as const, workspaceId: "workspace-a", computerId: "computer-a" };
  const target = { startUrl: "https://example.awsapps.com/start", region: "us-east-1" };
  const reports: RuntimeAuthLoginReport[] = [];
  const adapter: RuntimeAuthAdapter = {
    provider: "kiro",
    async startLogin(options, interaction) {
      expect(options.kiroIdentityCenter).toEqual(target);
      interaction.onEvent({
        kind: "device_code",
        verificationUrl: "https://device.sso.us-east-1.amazonaws.com/",
        userCode: "ABCD-EFGH",
      });
      return { status: "logged_in", authStatus: { provider: "kiro", state: "logged_in" } };
    },
    async readStatus() {
      return { provider: "kiro", state: "unknown" };
    },
    async submitCode() {},
    async cancel() {},
    async logout() {
      return { status: "failed", reason: "process_failed" };
    },
  };
  const controller = new RuntimeAuthController({
    owner,
    workingDirectory: "/fixture",
    createAdapter: () => adapter,
    async reportLogin(report) {
      reports.push(decodeRuntimeAuthLoginReport(encodeRuntimeAuthLoginReport(report)));
    },
    async reportLogout() {},
    async refresh() {},
  });
  await controller.handle({
    ...owner,
    kind: "login_start",
    loginId: "rtl_abcdefghijklmnop",
    provider: "kiro",
    kiroIdentityCenter: target,
  });
  expect(reports[0]?.event).toEqual({
    kind: "device_code",
    verificationUrl: "https://device.sso.us-east-1.amazonaws.com/",
    userCode: "ABCD-EFGH",
  });
  expect(reports[1]?.result).toEqual({ kind: "logged_in" });
  controller.stop();
});
