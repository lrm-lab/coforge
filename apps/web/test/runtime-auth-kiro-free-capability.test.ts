import { expect, test } from "bun:test";
import { decodeRuntimeAuthIntent } from "@lrm/coforge-sdk/internal";
import { RuntimeAuth } from "#src/server/computers/runtime-auth.server";
import type { RuntimeAuthStore as Store } from "#src/server/computers/runtime-auth-store.server";

/**
 * Kiro's free sign-in is a daemon feature a Computer advertises (`runtime-auth:kiro-free:v1`). The
 * page hides the choice when it is absent, but the Server Function is an interface too: a caller
 * that asks for it anyway must be refused, not sent to a Computer whose daemon would fail (task
 * #615).
 */
const principal = { userId: "u", workspaceId: "w" };
const freeInput = { computerId: "c", provider: "kiro" as const, kiroLicense: "free" as const };
const enterpriseInput = {
  computerId: "c",
  provider: "kiro" as const,
  kiroLicense: "pro" as const,
  kiroIdentityCenter: { startUrl: "https://example.awsapps.com/start", region: "us-east-1" },
};

function harness(options: { kiroFree: boolean; online?: boolean; supports?: boolean }) {
  const published: Uint8Array[] = [];
  const begun: string[] = [];
  const store = {
    begin: async (_scope: unknown, login: { loginId: string }) => {
      begun.push(login.loginId);
      return "started" as const;
    },
  } as unknown as Store;
  const auth = new RuntimeAuth(
    { canManage: async () => true },
    store,
    { publish: async (_channel: string, bytes: Uint8Array) => void published.push(bytes) },
    async () => options.online ?? true,
    {
      supports: async () => options.supports ?? true,
      supportsStatusRead: async () => true,
      supportsKiroFree: async () => options.kiroFree,
    },
    () => "rtl_0123456789abcdef",
    () => 1_000,
  );
  return { auth, published, begun };
}

test("a Computer that does not take the free sign-in is refused, and names what it lacks", async () => {
  const { auth, published, begun } = harness({ kiroFree: false });
  expect(await auth.startLogin(principal, freeInput)).toEqual({
    status: "needs_upgrade",
    missing: "kiro_free",
  });
  // Nothing was sent to the Computer and no login was claimed for it.
  expect(published).toEqual([]);
  expect(begun).toEqual([]);
});

test("a Computer that takes the free sign-in gets the intent, licence and all", async () => {
  const { auth, published } = harness({ kiroFree: true });
  expect(await auth.startLogin(principal, freeInput)).toEqual({
    status: "started",
    loginId: "rtl_0123456789abcdef",
  });
  expect(decodeRuntimeAuthIntent(published[0]!)).toMatchObject({
    kind: "login_start",
    provider: "kiro",
    kiroLicense: "free",
  });
});

test("the free-tier flag never gates the enterprise sign-in", async () => {
  // A Computer with the identity center but no free flag still signs in to the identity center.
  const { auth, published } = harness({ kiroFree: false });
  expect(await auth.startLogin(principal, enterpriseInput)).toMatchObject({ status: "started" });
  expect(decodeRuntimeAuthIntent(published[0]!)).toMatchObject({
    kind: "login_start",
    kiroLicense: "pro",
    kiroIdentityCenter: enterpriseInput.kiroIdentityCenter,
  });
});

test("an offline Computer is offline, not a missing capability", async () => {
  const { auth, published } = harness({ kiroFree: false, online: false });
  expect(await auth.startLogin(principal, freeInput)).toEqual({ status: "offline" });
  expect(published).toEqual([]);
});

test("a Computer too old for the runtime sign-in itself keeps the plain needs_upgrade", async () => {
  const { auth } = harness({ kiroFree: true, supports: false });
  expect(await auth.startLogin(principal, freeInput)).toEqual({ status: "needs_upgrade" });
});
