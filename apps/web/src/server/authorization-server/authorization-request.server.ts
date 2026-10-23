import { APP_IDENTITY_SCOPES } from "@lrm/coforge-sdk/internal/app-scopes";
/** What the authorization endpoint needs of a registered app (the app registry's `apps` row). */
export type AuthorizationClient = {
  key: string;
  name: string;
  /** None (`null`) when the app registered no homepage. */
  homepageUrl: string | null;
  /** Where the consent page loads its logo (`appLogoUrl`); none shows the monogram. */
  logoUrl: string | null;
  redirectUris: string[];
  allowedScopes: string[];
};

/** The `prompt` values OpenID Connect Core §3.1.2.1 defines. */
const PROMPT_VALUES = ["none", "login", "consent", "select_account"] as const;
type Prompt = (typeof PROMPT_VALUES)[number];

/** A checked authorization request: every binding a code minted for it carries. */
export type AuthorizationRequest = {
  clientId: string;
  redirectUri: string;
  state?: string;
  /** The requested scopes, each once, in request order; `openid` among them. */
  scopes: string[];
  /** The S256 PKCE challenge (RFC 7636). */
  codeChallenge: string;
  nonce?: string;
  prompt: Prompt[];
  /** OIDC `max_age`: the longest time, in seconds, since the person last signed in. */
  maxAge?: number;
};

/** The error codes this endpoint redirects with: RFC 6749 §4.1.2.1 and OIDC Core §3.1.2.6. */
export type AuthorizationErrorCode =
  | "invalid_request"
  | "unsupported_response_type"
  | "invalid_scope"
  | "access_denied"
  | "request_not_supported"
  | "request_uri_not_supported"
  | "login_required"
  | "consent_required"
  | "interaction_required";

/** Why a request cannot be answered at its redirect URI: shown on the page instead (RFC 6749
 * §4.1.2.1, §10.15). */
export type InvalidClientReason = "missing_client_id" | "unknown_client" | "invalid_redirect_uri";

type ParsedAuthorizationRequest<Client extends AuthorizationClient = AuthorizationClient> =
  | { status: "invalid_client"; reason: InvalidClientReason }
  | {
      status: "error";
      redirectUri: string;
      state?: string;
      error: AuthorizationErrorCode;
      description: string;
    }
  | { status: "valid"; client: Client; request: AuthorizationRequest };

/** RFC 7636 §4.2: the base64url SHA-256 of a verifier is 43 characters. */
const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const NON_NEGATIVE_INTEGER = /^\d{1,10}$/;

/**
 * Checks an authorization request. The app and its redirect URI come first, matched as exact
 * strings (RFC 9700 §2.1): until both are known good, nothing is sent anywhere, so a bad request
 * cannot bounce someone to a URL the app did not register. Every later error goes back to that
 * redirect URI. A parameter given twice is invalid (RFC 6749 §3.1), and an empty one is absent.
 */
export async function parseAuthorizationRequest<Client extends AuthorizationClient>(
  query: URLSearchParams,
  findClient: (key: string) => Promise<Client | undefined>,
): Promise<ParsedAuthorizationRequest<Client>> {
  const clientId = single(query, "client_id");
  if (!clientId) return { status: "invalid_client", reason: "missing_client_id" };
  const client = await findClient(clientId);
  if (!client) return { status: "invalid_client", reason: "unknown_client" };
  const redirectUri = single(query, "redirect_uri");
  if (!redirectUri || !client.redirectUris.includes(redirectUri))
    return { status: "invalid_client", reason: "invalid_redirect_uri" };

  const state = single(query, "state");
  const fail = (error: AuthorizationErrorCode, description: string) =>
    ({
      status: "error",
      redirectUri,
      ...(state ? { state } : {}),
      error,
      description,
    }) as const;

  const repeated = [...new Set(query.keys())].find((name) => query.getAll(name).length > 1);
  if (repeated) return fail("invalid_request", `${repeated} is repeated`);
  if (query.has("request")) return fail("request_not_supported", "request is not supported");
  if (query.has("request_uri"))
    return fail("request_uri_not_supported", "request_uri is not supported");

  const responseType = single(query, "response_type");
  if (!responseType) return fail("invalid_request", "response_type is required");
  if (responseType !== "code")
    return fail("unsupported_response_type", "only response_type code is supported");
  const responseMode = single(query, "response_mode");
  if (responseMode && responseMode !== "query")
    return fail("invalid_request", "only response_mode query is supported");

  const scopes = [...new Set((single(query, "scope") ?? "").split(" ").filter(Boolean))];
  if (!scopes.includes("openid")) return fail("invalid_scope", "scope must include openid");
  // The Agent inbound scopes are declared but never granted by a person's consent.
  if (
    scopes.some(
      (scope) =>
        !client.allowedScopes.includes(scope) ||
        !(APP_IDENTITY_SCOPES as readonly string[]).includes(scope),
    )
  )
    return fail("invalid_scope", "a requested scope is not allowed for this app");

  const codeChallenge = single(query, "code_challenge");
  if (!codeChallenge) return fail("invalid_request", "code_challenge is required");
  if (single(query, "code_challenge_method") !== "S256")
    return fail("invalid_request", "code_challenge_method must be S256");
  if (!S256_CHALLENGE.test(codeChallenge))
    return fail("invalid_request", "code_challenge is not an S256 challenge");

  const prompt = (single(query, "prompt") ?? "").split(" ").filter(Boolean);
  if (
    !prompt.every((value): value is Prompt => (PROMPT_VALUES as readonly string[]).includes(value))
  )
    return fail("invalid_request", "prompt has an unknown value");
  if (prompt.includes("none") && prompt.length > 1)
    return fail("invalid_request", "prompt none cannot be combined");

  const maxAge = single(query, "max_age");
  if (maxAge !== undefined && !NON_NEGATIVE_INTEGER.test(maxAge))
    return fail("invalid_request", "max_age must be a non-negative integer");

  const nonce = single(query, "nonce");
  return {
    status: "valid",
    client,
    request: {
      clientId,
      redirectUri,
      ...(state ? { state } : {}),
      scopes,
      codeChallenge,
      ...(nonce ? { nonce } : {}),
      prompt: [...new Set(prompt)],
      ...(maxAge !== undefined ? { maxAge: Number(maxAge) } : {}),
    },
  };
}

/** The parameter's one non-empty value; `undefined` when it is absent, empty or repeated. */
function single(query: URLSearchParams, name: string): string | undefined {
  const values = query.getAll(name);
  return values.length === 1 && values[0] ? values[0] : undefined;
}
