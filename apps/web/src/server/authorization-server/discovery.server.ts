import { SIGNING_ALGORITHM } from "./signing-keys.server";

/** The issuer's metadata: OpenID Connect Discovery 1.0 §3, served unchanged as RFC 8414 §2
 * authorization server metadata. It advertises only endpoints that exist and fixed policy; an
 * endpoint joins here in the same change that adds it.
 * https://openid.net/specs/openid-connect-discovery-1_0.html#ProviderMetadata */
export function discoveryDocument(issuer: string) {
  return {
    issuer,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: [SIGNING_ALGORITHM],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    scopes_supported: ["openid", "profile", "email", "workspace"],
    claims_supported: ["sub", "name", "email", "workspace_id", "workspace_slug", "workspace_role"],
    authorization_response_iss_parameter_supported: true,
    // Discovery §3 defaults this to true when omitted; this server takes no `request_uri`.
    request_uri_parameter_supported: false,
  };
}
