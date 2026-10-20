import { readEnvSecret } from "#src/server/files/env-secret.server";
import { AuthorizationServerConfigError } from "./configuration-error.server";
import { parseSigningKeys, type SigningKey } from "./signing-keys.server";

export type AuthorizationServerConfiguration =
  | { status: "disabled" }
  | { status: "ready"; issuer: string; signingKeys: SigningKey[] };

/** The issuer's path: the routes serve `/oidc/...` and `/.well-known/oauth-authorization-server/oidc`. */
const ISSUER_PATH = "/oidc";

/** Plain HTTP is for local development only. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

let remembered: AuthorizationServerConfiguration | undefined;

/** Publishes the configuration the boot read (`assertStartupConfig`), so requests never read it. */
export function rememberAuthorizationServerConfiguration(
  configuration: AuthorizationServerConfiguration,
): void {
  remembered = configuration;
}

/** What the boot remembered. Before the boot has remembered anything there is no server. */
export function authorizationServerConfiguration(): AuthorizationServerConfiguration {
  return remembered ?? { status: "disabled" };
}

/** An unset (or blank) issuer means this deployment runs no authorization server; a set but
 * unusable configuration throws `AuthorizationServerConfigError`, which fails the boot. */
export async function readAuthorizationServerConfiguration(
  environment: NodeJS.ProcessEnv,
): Promise<AuthorizationServerConfiguration> {
  const issuer = environment.COFORGE_OIDC_ISSUER;
  if (!issuer?.trim()) return { status: "disabled" };
  validateIssuer(issuer);
  const keyset = await readEnvSecret(environment, "COFORGE_OIDC_SIGNING_JWKS", (message) => {
    throw new AuthorizationServerConfigError(message);
  });
  if (!keyset)
    throw new AuthorizationServerConfigError(
      "COFORGE_OIDC_SIGNING_JWKS or COFORGE_OIDC_SIGNING_JWKS_FILE is required with COFORGE_OIDC_ISSUER",
    );
  return { status: "ready", issuer, signingKeys: await parseSigningKeys(keyset) };
}

/** The issuer is `<origin>/oidc` byte for byte (clients compare it exactly): an `https` origin, or
 * `http` on a loopback host, then the fixed path, and nothing else — no credentials, query,
 * fragment, trailing slash or surrounding whitespace (OIDC Discovery §3 and §4.3, RFC 8414 §2
 * and §3.3). */
function validateIssuer(issuer: string): void {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new AuthorizationServerConfigError("COFORGE_OIDC_ISSUER must be an absolute URL");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)))
    throw new AuthorizationServerConfigError(
      "COFORGE_OIDC_ISSUER must use https (http only for a loopback host)",
    );
  // Comparing with the origin the URL parses to also rejects what `URL` would normalize away.
  if (issuer !== `${url.origin}${ISSUER_PATH}`)
    throw new AuthorizationServerConfigError(
      `COFORGE_OIDC_ISSUER must be exactly <origin>${ISSUER_PATH}: no other path, credentials, query, fragment, trailing slash or whitespace`,
    );
}
