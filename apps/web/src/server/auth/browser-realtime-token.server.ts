import { importJWK, SignJWT, type JWK } from "jose";

import { terminalAttachChannel } from "#src/features/computers/terminal/computer-terminal-channel";

export const BROWSER_PAGE_META = { page: true } as const;
export const TERMINAL_SUBSCRIPTION_TTL_SECONDS = 60;

export { terminalAttachChannel };

async function signBrowserRealtimeJwt(
  environment: Record<string, string | undefined>,
  claims: Record<string, unknown>,
  userId: string,
  options?: { issuedAtSeconds?: number; expiresAtSeconds?: number },
) {
  const raw = environment.COFORGE_WORKER_JWT_PRIVATE_JWK;
  const kid = environment.COFORGE_WORKER_JWT_KEY_ID;
  if (!raw || !kid) throw new Error("Browser realtime authentication is not configured");
  const key = await importJWK(JSON.parse(raw) as JWK, "EdDSA");
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", kid, typ: "JWT" })
    .setSubject(userId)
    .setIssuer(environment.COFORGE_WORKER_JWT_ISSUER ?? "coforge")
    .setAudience(environment.COFORGE_WORKER_JWT_AUDIENCE ?? "coforge-centrifugo");
  if (options?.issuedAtSeconds !== undefined && options?.expiresAtSeconds !== undefined) {
    jwt.setIssuedAt(options.issuedAtSeconds);
    jwt.setExpirationTime(options.expiresAtSeconds);
  } else {
    jwt.setIssuedAt();
    jwt.setExpirationTime("5m");
  }
  return jwt.sign(key);
}

export async function issueBrowserRealtimeToken(
  input: { userId: string; workspaceId: string },
  environment: Record<string, string | undefined> = process.env,
): Promise<string> {
  return signBrowserRealtimeJwt(environment, { meta: BROWSER_PAGE_META }, input.userId);
}

export async function issueTerminalSubscriptionToken(
  input: { userId: string; attachId: string; ttlSeconds?: number; now?: () => number },
  environment: Record<string, string | undefined> = process.env,
): Promise<{ token: string; channel: string; expiresAtMs: number }> {
  const channel = terminalAttachChannel(input.attachId);
  const issuedAtSeconds = Math.floor((input.now?.() ?? Date.now()) / 1000);
  const ttl = input.ttlSeconds ?? TERMINAL_SUBSCRIPTION_TTL_SECONDS;
  const expiresAtSeconds = issuedAtSeconds + ttl;
  const token = await signBrowserRealtimeJwt(environment, { channel }, input.userId, {
    issuedAtSeconds,
    expiresAtSeconds,
  });
  return { token, channel, expiresAtMs: expiresAtSeconds * 1000 };
}
