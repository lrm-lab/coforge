import { importJWK, SignJWT, type JWK } from "jose";

/** The connection meta of a browser page's connection, never of a daemon's (whose meta the connect
 * proxy sets). Centrifugo keeps it server side and hands it to the subscribe proxy. */
export const BROWSER_PAGE_META = { page: true } as const;

async function browserRealtimeSigner(
  environment: Record<string, string | undefined>,
  claims: Record<string, unknown>,
  userId: string,
) {
  const raw = environment.COFORGE_WORKER_JWT_PRIVATE_JWK;
  const kid = environment.COFORGE_WORKER_JWT_KEY_ID;
  if (!raw || !kid) throw new Error("Browser realtime authentication is not configured");
  const key = await importJWK(JSON.parse(raw) as JWK, "EdDSA");
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", kid, typ: "JWT" })
    .setSubject(userId)
    .setIssuer(environment.COFORGE_WORKER_JWT_ISSUER ?? "coforge")
    .setAudience(environment.COFORGE_WORKER_JWT_AUDIENCE ?? "coforge-centrifugo")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key);
}

export async function issueBrowserRealtimeToken(
  input: { userId: string; workspaceId: string },
  environment: Record<string, string | undefined> = process.env,
): Promise<string> {
  // The connection token grants no channels of its own: a page subscribes every channel
  // without a token, and the subscribe proxy checks each one. Its meta marks the
  // connection as a page's, which that proxy requires.
  return browserRealtimeSigner(environment, { meta: BROWSER_PAGE_META }, input.userId);
}
