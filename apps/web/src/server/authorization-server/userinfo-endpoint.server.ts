import { isFormRequest } from "#src/lib/form-request";
import { bearerChallenge, bearerToken } from "./bearer-challenge.server";
import { activeGrant, scopeClaims, type GrantStore } from "./grants.server";
import { NO_STORE } from "./http-headers.server";
import { verifyAccessToken, type TokenIssuer } from "./issued-tokens.server";

/**
 * The UserInfo endpoint (OIDC Core §5.3): the claims an access token's scopes release about the
 * person, read as they are now. The token comes as RFC 6750 allows a client to send it: in the
 * Authorization header (GET or POST), or as `access_token` in a POSTed form (§2.2); never both,
 * and never in the query.
 */
export class UserInfoEndpoint {
  private readonly now: () => Date;

  constructor(
    private readonly store: Pick<GrantStore, "findRedeemedCode" | "findGrantSubject">,
    private readonly options: TokenIssuer & { now?: () => Date },
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async answer(request: Request): Promise<Response> {
    const presented = await presentedToken(request);
    if (presented.status === "absent") return this.challenge();
    if (presented.status === "invalid_request")
      return this.challenge({
        error: "invalid_request",
        status: 400,
        description: presented.description,
      });
    const verified = await verifyAccessToken(this.options, presented.token, this.now());
    const code = verified && (await this.store.findRedeemedCode(verified.grantId));
    const grant = code && activeGrant(code, await this.store.findGrantSubject(code));
    if (!grant || grant.userId !== verified.userId)
      return this.challenge({
        error: "invalid_token",
        status: 401,
        description: "the access token is not valid",
      });
    return Response.json(
      { sub: grant.userId, ...scopeClaims(grant, this.options.issuer) },
      { headers: NO_STORE },
    );
  }

  /** RFC 6750 §3: a request without a token gets the bare challenge, an error names its code. */
  private challenge(refusal?: {
    error: "invalid_request" | "invalid_token";
    status: 400 | 401;
    description: string;
  }): Response {
    return bearerChallenge(
      this.options.issuer,
      refusal?.status ?? 401,
      refusal && { error: refusal.error, description: refusal.description },
    );
  }
}

type PresentedToken =
  | { status: "presented"; token: string }
  | { status: "absent" }
  | { status: "invalid_request"; description: string };

async function presentedToken(request: Request): Promise<PresentedToken> {
  const authorization = request.headers.get("authorization");
  const fromForm = request.method === "POST" ? await formToken(request) : undefined;
  if (authorization !== null && fromForm !== undefined)
    return { status: "invalid_request", description: "send the access token one way only" };
  if (fromForm !== undefined) return { status: "presented", token: fromForm };
  if (authorization === null) return { status: "absent" };
  const token = bearerToken(authorization);
  return token
    ? { status: "presented", token }
    : { status: "invalid_request", description: "the Authorization header is not a Bearer token" };
}

/** The `access_token` of a form-encoded body (RFC 6750 §2.2), if any. */
async function formToken(request: Request): Promise<string | undefined> {
  if (!isFormRequest(request)) return undefined;
  return new URLSearchParams(await request.text()).get("access_token") || undefined;
}
