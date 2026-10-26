import { expect, test } from "bun:test";
import { encodeRuntimeAuthIntent, decodeRuntimeAuthIntent } from "./runtime-auth";

const base = {
  protocolMajor: 1 as const,
  workspaceId: "workspace-1",
  computerId: "computer-1",
  kind: "login_start" as const,
  loginId: "rtl_abcdefghijklmnop",
  provider: "kiro" as const,
};
const kiroIdentityCenter = { startUrl: "https://example.awsapps.com/start", region: "us-east-1" };

test("Kiro enterprise login carries its target through the existing intent", () => {
  const intent = { ...base, kiroIdentityCenter };
  expect(decodeRuntimeAuthIntent(encodeRuntimeAuthIntent(intent))).toEqual(intent);
});

test("Kiro enterprise login rejects incomplete targets and targets attached to other runtimes", () => {
  for (const options of [
    undefined,
    {},
    { ...kiroIdentityCenter, startUrl: "http://example.com" },
    { ...kiroIdentityCenter, startUrl: "https://user:password@example.com" },
    { ...kiroIdentityCenter, region: "us-east-1\nquit" },
  ]) {
    expect(() =>
      encodeRuntimeAuthIntent({ ...base, kiroIdentityCenter: options } as never),
    ).toThrow();
  }
  expect(() =>
    encodeRuntimeAuthIntent({ ...base, provider: "codex", kiroIdentityCenter } as never),
  ).toThrow();
});
