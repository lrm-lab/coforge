import { describe, expect, test } from "bun:test";

import {
  CLOUD_SERVICE_UNLOCK_SECONDS,
  CloudServiceAttempts,
  cloudServiceCookieValue,
  cloudServicePasswordAccepted,
  cloudServiceUnlockValid,
  sealCloudServiceUnlock,
  serializeCloudServiceCookie,
} from "#src/server/workspaces/cloud-service-access.server";

const now = new Date("2026-10-15T07:00:00.000Z");
const secret = "session-secret-at-least-32-characters";
const password = "operator-password";

describe("cloud computer service access", () => {
  test("accepts only the configured operating password", () => {
    expect(cloudServicePasswordAccepted(password, password)).toBe(true);
    expect(cloudServicePasswordAccepted("123456", "123456")).toBe(true);
    expect(cloudServicePasswordAccepted("operator-passworD", password)).toBe(false);
    expect(cloudServicePasswordAccepted("", password)).toBe(false);
    expect(cloudServicePasswordAccepted(password, undefined)).toBe(false);
    expect(cloudServicePasswordAccepted(password, "short")).toBe(false);
  });

  test("a sealed unlock stays valid until it expires, and a changed seal does not", () => {
    const token = sealCloudServiceUnlock(now, secret);
    expect(cloudServiceUnlockValid(token, new Date(now.getTime() + 1_000), secret)).toBe(true);
    expect(
      cloudServiceUnlockValid(
        token,
        new Date(now.getTime() + CLOUD_SERVICE_UNLOCK_SECONDS * 1000),
        secret,
      ),
    ).toBe(false);
    expect(cloudServiceUnlockValid(`${token}x`, now, secret)).toBe(false);
    expect(cloudServiceUnlockValid(token, now, "another-session-secret-32-characters")).toBe(false);
  });

  test("the unlock cookie is http-only and only marked secure on https", () => {
    const token = sealCloudServiceUnlock(now, secret);
    const cookie = serializeCloudServiceCookie(token, false);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain(`Max-Age=${CLOUD_SERVICE_UNLOCK_SECONDS}`);
    expect(cookie).not.toContain("Secure");
    expect(serializeCloudServiceCookie(token, true)).toContain("Secure");
    expect(cloudServiceCookieValue(cookie)).toBe(token);
  });

  test("too many attempts in a minute are refused", () => {
    const attempts = new CloudServiceAttempts();
    for (let i = 0; i < 8; i += 1) expect(attempts.allowed("user-1", now)).toBe(true);
    expect(attempts.allowed("user-1", now)).toBe(false);
    expect(attempts.allowed("user-2", now)).toBe(true);
    expect(attempts.allowed("user-1", new Date(now.getTime() + 60_000))).toBe(true);
  });

  // A failed Web Crypto key import leaves an error on the thread's OpenSSL error queue (Bun 1.4.3);
  // sealing and checking must not read it as their own failure.
  test("an unlock still seals and checks after a Web Crypto key import failed", async () => {
    await failWebCryptoKeyImport();
    const token = sealCloudServiceUnlock(now, secret);
    await failWebCryptoKeyImport();
    expect(cloudServiceUnlockValid(token, now, secret)).toBe(true);
  });

  test("the password still checks after a Web Crypto key import failed", async () => {
    await failWebCryptoKeyImport();
    expect(cloudServicePasswordAccepted(password, password)).toBe(true);
  });
});

async function failWebCryptoKeyImport() {
  const algorithm = { name: "ECDSA", namedCurve: "P-256" };
  const { privateKey } = await crypto.subtle.generateKey(algorithm, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  await expect(
    crypto.subtle.importKey("jwk", { ...jwk, d: "AA" }, algorithm, false, ["sign"]),
  ).rejects.toThrow();
}
