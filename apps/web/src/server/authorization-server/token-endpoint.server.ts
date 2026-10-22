import { isFormRequest } from "#src/lib/form-request";
import { appClientSecretMatches } from "#src/server/apps/app-client-secret.server";
import { hashAuthorizationCode } from "./authorization-codes.server";
import { readClientCredentials } from "./client-authentication.server";
import type { InstallationTokenRefusal, InstallationTokens } from "./installation-tokens.server";
import { activeGrant, type GrantStore } from "./grants.server";
import { NO_STORE } from "./http-headers.server";
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
  | "invalid_client"
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
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async exchange(request: Request): Promise<Response> {
    const form = await readForm(request);
    if (!form)
      return tokenError("invalid_request", "the request must be a form with each parameter once");
    const credentials = readClientCredentials(request.headers.get("authorization"), form);
    if (credentials.status === "ambiguous")
      return tokenError("invalid_request", "use one client authentication method");
    if (credentials.status === "invalid") return this.unauthenticated();
    const grantType = form.get("grant_type");
    const presentedCode = form.get("code");
    const redirectUri = form.get("redirect_uri");
    // The client and the code are read together. An unknown client_id is refused without a
    // secret comparison: client ids are public, so timing reveals nothing secret.
    const [client, code] = await Promise.all([
      this.store.findClient(credentials.clientId),
      presentedCode ? this.store.findCode(hashAuthorizationCode(presentedCode)) : undefined,
    ]);
    if (!client || !appClientSecretMatches(client.clientSecretHash, credentials.clientSecret))
      return this.unauthenticated();

    if (!grantType) return tokenError("invalid_request", "grant_type is required");
    if (grantType === "client_credentials")
      return this.issueInstallationToken({ id: client.id, key: credentials.clientId }, form);
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
    const result = await this.installationTokens.issue(client, form, this.now());
    if (result.status === "refused") return tokenError(result.error, result.description);
    return Response.json(result.body, { headers: NO_STORE });
  }

  private unauthenticated(): Response {
    return tokenError("invalid_client", "client authentication failed", this.options.issuer);
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

/** RFC 6749 §5.2. `invalid_client` is a 401, which names the scheme to authenticate with
 * (RFC 9110 §15.5.2) whichever method the app tried. */
function tokenError(error: TokenErrorCode, description: string, realm?: string): Response {
  const unauthorized = error === "invalid_client";
  return Response.json(
    { error, error_description: description },
    {
      status: unauthorized ? 401 : 400,
      headers: unauthorized
        ? { ...NO_STORE, "www-authenticate": `Basic realm="${realm}"` }
        : NO_STORE,
    },
  );
}
