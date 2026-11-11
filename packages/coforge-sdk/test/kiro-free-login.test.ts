import { expect, test } from "bun:test";
import {
  encodeRuntimeAuthIntent,
  decodeRuntimeAuthIntent,
  runtimeAuthKiroLogin,
} from "@lrm/coforge-sdk/internal";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal/runtime-provider";

const scope = { protocolMajor: 1 as const, workspaceId: "w", computerId: "c" };
const identityCenter = { startUrl: "https://example.awsapps.com/start", region: "us-east-1" };

test("a Kiro free sign-in carries its license and no identity center", () => {
  const intent = {
    ...scope,
    kind: "login_start" as const,
    loginId: "rtl_abcdefghijklmnop",
    provider: RUNTIME_PROVIDER.KIRO,
    kiroLicense: "free" as const,
  };
  const decoded = decodeRuntimeAuthIntent(encodeRuntimeAuthIntent(intent));
  expect(decoded).toMatchObject({ kiroLicense: "free" });
  expect(decoded).not.toHaveProperty("kiroIdentityCenter");
});

test("a Kiro identity-center sign-in keeps its target and says which license it is", () => {
  const intent = {
    ...scope,
    kind: "login_start" as const,
    loginId: "rtl_abcdefghijklmnop",
    provider: RUNTIME_PROVIDER.KIRO,
    kiroIdentityCenter: identityCenter,
  };
  // No license is today's server: it means the identity-center sign-in, unchanged.
  expect(runtimeAuthKiroLogin(RUNTIME_PROVIDER.KIRO, identityCenter, undefined)).toEqual({
    license: "pro",
    identityCenter,
  });
  const decoded = decodeRuntimeAuthIntent(encodeRuntimeAuthIntent(intent));
  // An intent that names no license keeps the shape it always had: absent means `pro`.
  expect(decoded).toMatchObject({ kiroIdentityCenter: identityCenter });
  expect(decoded).not.toHaveProperty("kiroLicense");
});

test("a free sign-in that names an identity center is refused, not silently ignored", () => {
  expect(() => runtimeAuthKiroLogin(RUNTIME_PROVIDER.KIRO, identityCenter, "free")).toThrow(
    "A free Kiro sign-in names no identity center",
  );
});

test("Kiro still refuses a sign-in with no target at all, and other providers refuse Kiro's", () => {
  expect(() => runtimeAuthKiroLogin(RUNTIME_PROVIDER.KIRO, undefined, undefined)).toThrow(
    "Kiro enterprise target required",
  );
  expect(() => runtimeAuthKiroLogin(RUNTIME_PROVIDER.KIRO, undefined, "pro")).toThrow(
    "Kiro enterprise target required",
  );
  expect(() => runtimeAuthKiroLogin(RUNTIME_PROVIDER.CODEX, undefined, "free")).toThrow(
    "Kiro sign-in options belong to Kiro only",
  );
});
