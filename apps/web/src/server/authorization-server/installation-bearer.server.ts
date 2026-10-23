import { bearerChallenge, bearerFromRequest } from "./bearer-challenge.server";
import type {
  InstallationTokenFlag,
  InstallationTokens,
  InstallationTokenVerification,
} from "./installation-tokens.server";

export type VerifiedInstallationToken = Extract<
  InstallationTokenVerification,
  { status: "verified" }
>;

/**
 * Authenticates the installation token of an API request (RFC 6750 §2.1, the Authorization header
 * only) against the installation named in the path, for the API behind `flag`. Every refusal is
 * RFC 6750 §3 and comes back as the response to send: a missing token gets the bare challenge, a
 * malformed header 400 `invalid_request`, an unusable token (including an installation id that is
 * malformed, unknown or another token's) 401 `invalid_token`, a token whose groups are no longer
 * approved 403 `insufficient_scope` (naming `scope` when the API needs one).
 */
export async function verifyInstallationBearer(
  request: Request,
  installationId: string,
  api: {
    tokens: Pick<InstallationTokens, "verify">;
    flag: InstallationTokenFlag;
    issuer: string;
    now: Date;
    scope?: string;
  },
): Promise<VerifiedInstallationToken | Response> {
  const token = bearerFromRequest(request, api.issuer);
  if (token instanceof Response) return token;
  const verified = await api.tokens.verify(token, installationId, api.now, api.flag);
  if (verified.status === "verified") return verified;
  return verified.error === "insufficient_scope"
    ? insufficientScope(api.issuer, api.scope)
    : bearerChallenge(api.issuer, 401, {
        error: "invalid_token",
        description: "the access token is not valid for this installation",
      });
}

/** 403 `insufficient_scope`, naming the `scope` the API needs when it needs one. */
export function insufficientScope(issuer: string, scope?: string): Response {
  return bearerChallenge(issuer, 403, {
    error: "insufficient_scope",
    description: "the access token does not carry the scope this endpoint needs",
    ...(scope ? { scope } : {}),
  });
}
