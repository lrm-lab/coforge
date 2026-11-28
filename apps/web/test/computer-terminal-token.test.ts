import { expect, test } from "bun:test";
import { exportJWK, generateKeyPair, jwtVerify } from "jose";

import {
  issueTerminalSubscriptionToken,
  TERMINAL_SUBSCRIPTION_TTL_SECONDS,
} from "#src/server/auth/browser-realtime-token.server";

test("issueTerminalSubscriptionToken binds sub, single attach channel, and 60s expiry", async () => {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { extractable: true });
  const privateJwk = await exportJWK(privateKey);
  const nowMs = 1_700_000_000_000;

  const issued = await issueTerminalSubscriptionToken(
    {
      userId: "user-123",
      attachId: "ta_abc123",
      now: () => nowMs,
    },
    {
      COFORGE_WORKER_JWT_PRIVATE_JWK: JSON.stringify(privateJwk),
      COFORGE_WORKER_JWT_KEY_ID: "kid-1",
      COFORGE_WORKER_JWT_ISSUER: "coforge",
      COFORGE_WORKER_JWT_AUDIENCE: "coforge-centrifugo",
    },
  );

  expect(issued.channel).toBe("terminal:ta_abc123");
  expect(issued.expiresAtMs).toBe(nowMs + TERMINAL_SUBSCRIPTION_TTL_SECONDS * 1000);

  const verified = await jwtVerify(issued.token, publicKey, {
    issuer: "coforge",
    audience: "coforge-centrifugo",
    currentDate: new Date(nowMs + 10_000),
  });
  expect(verified.payload.sub).toBe("user-123");
  expect(verified.payload.channel).toBe("terminal:ta_abc123");
  expect(verified.payload.iat).toBe(1_700_000_000);
  expect(verified.payload.exp).toBe(1_700_000_000 + TERMINAL_SUBSCRIPTION_TTL_SECONDS);
});
