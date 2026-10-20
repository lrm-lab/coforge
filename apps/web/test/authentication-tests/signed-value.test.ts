import { expect, test } from "bun:test";

import { readSignedValue, signValue } from "#src/server/auth/signed-value.server";

const SECRET = "test-session-secret-at-least-32-characters";

/**
 * A failed Web Crypto key import leaves an error on the thread's OpenSSL error queue (Bun 1.4.3).
 * Signing must not read it as its own failure: the authorization server refuses a bad signing key
 * this way, and the same process then signs sessions and sign-in notes.
 */
test("signing still works after a Web Crypto key import failed on the same thread", async () => {
  const { privateKey } = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  await expect(
    crypto.subtle.importKey(
      "jwk",
      { ...jwk, d: "AA" },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    ),
  ).rejects.toThrow();

  const signed = signValue("session", { userId: "user-1" }, SECRET);
  expect(readSignedValue<{ userId: string }>("session", signed, SECRET)).toEqual({
    userId: "user-1",
  });
});
