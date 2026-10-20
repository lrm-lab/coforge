import type { PrismaClient } from "#src/generated/prisma/client";
import { readSessionSecret } from "#src/server/auth/config.server";
import { requireDatabaseClient } from "#src/server/db/client.server";
import { PrismaAuthorizationStore } from "#src/server/db/repositories/oauth-authorization.repositories.server";
import { AuthorizationEndpoint } from "./authorization-endpoint.server";
import { authorizationServerConfiguration } from "./configuration.server";

/** The authorization endpoint over PostgreSQL, its handles signed with `secret`. */
export function createAuthorizationEndpoint({
  issuer,
  secret,
  db = requireDatabaseClient(),
  now,
}: {
  issuer: string;
  secret: string;
  db?: PrismaClient;
  now?: () => Date;
}): AuthorizationEndpoint {
  return new AuthorizationEndpoint(new PrismaAuthorizationStore(db), { issuer, secret, now });
}

/** The endpoint of the configured issuer, or null when this deployment runs no authorization
 * server. Its handles are signed with the session secret. */
export async function currentAuthorizationEndpoint(): Promise<AuthorizationEndpoint | null> {
  const configuration = authorizationServerConfiguration();
  if (configuration.status === "disabled") return null;
  return createAuthorizationEndpoint({
    issuer: configuration.issuer,
    secret: await readSessionSecret(process.env),
  });
}
