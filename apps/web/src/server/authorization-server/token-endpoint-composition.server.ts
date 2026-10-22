import type { PrismaClient } from "#src/generated/prisma/client";
import { requireDatabaseClient } from "#src/server/db/client.server";
import { PrismaGrantStore } from "#src/server/db/repositories/oauth-grant.repositories.server";
import { PrismaAppPermissionsStore } from "#src/server/db/repositories/app-permissions.repositories.server";
import { isFeatureEnabled } from "#src/server/feature-flags/feature-flags.server";
import { authorizationServerConfiguration } from "./configuration.server";
import { InstallationTokens } from "./installation-tokens.server";
import type { SigningKey } from "./signing-keys.server";
import { TokenEndpoint } from "./token-endpoint.server";
import { UserInfoEndpoint } from "./userinfo-endpoint.server";

/** The token and UserInfo endpoints over PostgreSQL, signing with `signingKeys`, and the
 * installation tokens the token endpoint issues and a read API verifies. */
export function createTokenEndpoints({
  issuer,
  signingKeys,
  db = requireDatabaseClient(),
  now,
}: {
  issuer: string;
  signingKeys: SigningKey[];
  db?: PrismaClient;
  now?: () => Date;
}): { token: TokenEndpoint; userInfo: UserInfoEndpoint; installationTokens: InstallationTokens } {
  const store = new PrismaGrantStore(db);
  const options = { issuer, signingKeys, ...(now ? { now } : {}) };
  const installationTokens = new InstallationTokens(
    new PrismaAppPermissionsStore(db),
    (workspace) => isFeatureEnabled("app-data-permissions", workspace),
    options,
  );
  return {
    token: new TokenEndpoint(store, options, installationTokens),
    userInfo: new UserInfoEndpoint(store, options),
    installationTokens,
  };
}

/** The endpoints of the configured issuer, or null when this deployment runs no authorization
 * server. */
export function currentTokenEndpoints(): ReturnType<typeof createTokenEndpoints> | null {
  const configuration = authorizationServerConfiguration();
  if (configuration.status === "disabled") return null;
  return createTokenEndpoints({
    issuer: configuration.issuer,
    signingKeys: configuration.signingKeys,
  });
}
