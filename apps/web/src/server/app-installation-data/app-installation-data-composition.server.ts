import type { PrismaClient } from "#src/generated/prisma/client";
import { getAppRateLimits } from "#src/server/app-rate-limits/app-rate-limits-composition.server";
import { authorizationServerConfiguration } from "#src/server/authorization-server/configuration.server";
import { NO_STORE } from "#src/server/authorization-server/http-headers.server";
import { createTokenEndpoints } from "#src/server/authorization-server/token-endpoint-composition.server";
import { getComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import { requireDatabaseClient } from "#src/server/db/client.server";
import { PrismaAppInstallationDataStore } from "#src/server/db/repositories/app-installation-data.repositories.server";
import type { SigningKey } from "#src/server/authorization-server/signing-keys.server";
import { AppInstallationApi, type InstallationDataGroup } from "./app-installation-api.server";
import { AppInstallationData, type ComputerPresence } from "./app-installation-data.server";

/** The read endpoints over PostgreSQL and the Computer status cache, verifying the installation
 * tokens `signingKeys` signed. */
export function createAppInstallationApi({
  issuer,
  signingKeys,
  db = requireDatabaseClient(),
  presence = (scopes) => getComputerStatusCache().getMany(scopes),
  now,
}: {
  issuer: string;
  signingKeys: SigningKey[];
  db?: PrismaClient;
  presence?: ComputerPresence;
  now?: () => Date;
}) {
  const { installationTokens } = createTokenEndpoints({ issuer, signingKeys, db, now });
  return new AppInstallationApi(
    installationTokens,
    new AppInstallationData(new PrismaAppInstallationDataStore(db), presence, issuer),
    issuer,
    now ?? (() => new Date()),
    getAppRateLimits().installation,
  );
}

let built: { configuration: object; api: AppInstallationApi } | undefined;

/** The read API of the configured issuer, built once per configuration (the token endpoints it
 * composes hold the signing-key sets and the PostgreSQL stores). */
function currentAppInstallationApi(configuration: {
  issuer: string;
  signingKeys: SigningKey[];
}): AppInstallationApi {
  if (built?.configuration !== configuration)
    built = { configuration, api: createAppInstallationApi(configuration) };
  return built.api;
}

/** One read endpoint of the configured issuer; 404 where this deployment runs no authorization
 * server. */
export async function readAppInstallation(
  request: Request,
  installationId: string,
  group: InstallationDataGroup,
): Promise<Response> {
  const configuration = authorizationServerConfiguration();
  if (configuration.status === "disabled")
    return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  return currentAppInstallationApi(configuration).read(request, installationId, group);
}
