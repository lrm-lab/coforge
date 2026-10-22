import { isFormRequest } from "#src/lib/form-request";
import { hashAuthorizationCode } from "./authorization-codes.server";
import { authenticateClient } from "./client-authentication.server";
import type { InstallationTokenRefusal, InstallationTokens } from "./installation-tokens.server";
import { activeGrant, type GrantStore } from "./grants.server";
import type { AppRateLimit } from "#src/server/app-rate-limits/app-rate-limit.server";
import { NO_STORE, refuseIfRateLimited } from "./http-headers.server";
import { verifierMatchesChallenge } from "./pkce.server";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  mintAccessToken,
  mintIdToken,
  type TokenIssuer,
} from "./issued-tokens.server";

/** RFC 6749 §5.2. */
type TokenErrorCode =
  | "invalid_request"
  | "invalid_grant"
  | "unsupported_grant_type"
  | InstallationTokenRefusal;

/**
 * The token endpoint (RFC 6749 §4.1.3–4.1.4, OIDC Core §3.1.3): an app redeems an authorization
 * code once for an access token and an ID token. An app also gets an installation token by
 * `client_credentials` (RFC 6749 §4.4). No refresh token is issued.
 */
export class TokenEndpoint {
  private readonly now: () => Date;

  constructor(
    private readonly store: GrantStore,
    private readonly options: TokenIssuer & { now?: () => Date },
    private readonly installationTokens: InstallationTokens,
    private readonly clientCredentialsLimit: AppRateLimit,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async exchange(request: Request): Promise<Response> {
    const form = await readForm(request);
    if (!form)
      return tokenError("invalid_request", "the request must be a form with each parameter once");
    const authenticated = await authenticateClient(request, this.store, this.options.issuer, form);
    if (authenticated instanceof Response) return authenticated;
    const { client, clientId } = authenticated;
    const grantType = form.get("grant_type");
    const presentedCode = form.get("code");
    const redirectUri = form.get("redirect_uri");
    const code = presentedCode
      ? await this.store.findCode(hashAuthorizationCode(presentedCode))
      : undefined;

    if (!grantType) return tokenError("invalid_request", "grant_type is required");
    if (grantType === "client_credentials")
      return this.issueInstallationToken({ id: client.id, key: clientId }, form);
    if (grantType !== "authorization_code")
      return tokenError("unsupported_grant_type", "only authorization_code is supported");
    if (!presentedCode || !redirectUri)
      return tokenError("invalid_request", "code and redirect_uri are required");

    // Another app's code is refused before anything else is said about it, so presenting a
    // stolen code cannot end the grant of the app it was issued to.
    if (!code || code.appId !== client.id)
      return tokenError("invalid_grant", "the code is not valid");
    const now = this.now();
    if (code.consumedAt) return this.refuseReplay(code.id, now);
    if (code.expiresAt <= now) return tokenError("invalid_grant", "the code has expired");
    if (code.redirectUri !== redirectUri)
      return tokenError("invalid_grant", "redirect_uri does not match the authorization request");
    if (!verifierMatchesChallenge(form.get("code_verifier"), code.codeChallenge))
      return tokenError("invalid_grant", "code_verifier does not match the code challenge");
    // Another redemption may have won since the code was read.
    if (!(await this.store.redeemCode(code.id, now))) return this.refuseReplay(code.id, now);
    const grant = activeGrant(
      { ...code, replayed: false },
      await this.store.findGrantSubject(code),
    );
    if (!grant) return tokenError("invalid_grant", "the grant is no longer valid");

    const accessToken = await mintAccessToken(
      this.options,
      { grantId: grant.id, userId: grant.userId, clientId: grant.clientId, scopes: grant.scopes },
      now,
    );
    const idToken = await mintIdToken(
      this.options,
      {
        userId: grant.userId,
        clientId: grant.clientId,
        authTime: grant.authTime,
        ...(grant.nonce ? { nonce: grant.nonce } : {}),
        accessToken,
      },
      now,
    );
    return Response.json(
      {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        id_token: idToken,
        scope: grant.scopes.join(" "),
      },
      { headers: NO_STORE },
    );
  }

  /** RFC 6749 §4.4: the app's own installation token; no refresh token (§4.4.3). */
  private async issueInstallationToken(
    client: { id: string; key: string },
    form: URLSearchParams,
  ): Promise<Response> {
    // Counted only for an authenticated client, so a flood of bad secrets cannot spend an app's budget.
    const refusal = await refuseIfRateLimited(this.clientCredentialsLimit, client.id);
    if (refusal) return refusal;
    const result = await this.installationTokens.issue(client, form, this.now());
    if (result.status === "refused") return tokenError(result.error, result.description);
    return Response.json(result.body, { headers: NO_STORE });
  }

  /** RFC 6749 §4.1.2 and §10.5: a code used twice is refused, and the tokens it yielded stop
   * working (UserInfo refuses a replayed grant). */
  private async refuseReplay(codeId: string, now: Date): Promise<Response> {
    await this.store.markCodeReplayed(codeId, now);
    return tokenError("invalid_grant", "the code was already used");
  }
}

/** The request's form (RFC 6749 §4.1.3), with every empty parameter dropped as absent; none when
 * the body is another media type or repeats a parameter (§3.2). */
async function readForm(request: Request): Promise<URLSearchParams | undefined> {
  if (!isFormRequest(request)) return undefined;
  const form = new URLSearchParams();
  const seen = new Set<string>();
  for (const [name, value] of new URLSearchParams(await request.text())) {
    if (seen.has(name)) return undefined;
    seen.add(name);
    if (value) form.set(name, value);
  }
  return form;
}

/** RFC 6749 §5.2. */
function tokenError(error: TokenErrorCode, description: string): Response {
  return Response.json(
    { error, error_description: description },
    { status: 400, headers: NO_STORE },
  );
}
