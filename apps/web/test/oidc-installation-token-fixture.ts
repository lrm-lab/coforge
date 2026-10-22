import type { AppPermissionGroup } from "#src/features/apps/app-permissions";
import {
  NO_RATE_LIMIT,
  type AppRateLimit,
} from "#src/server/app-rate-limits/app-rate-limit.server";
import {
  InstallationTokens,
  installationResource,
  type TokenInstallation,
} from "#src/server/authorization-server/installation-tokens.server";
import { TokenEndpoint } from "#src/server/authorization-server/token-endpoint.server";
import { CLIENT, ISSUER, SIGNING_KEYS, basic, endpoints } from "./oidc-token-fixture";

/** The token endpoint with installation tokens over an in-memory installation of `CLIENT`'s app,
 * shared by the installation token tests. A test changes `installation` or `flag` to model what
 * happened since, and moves `clock.now`. */

export const INSTALLATION_ID = "0192d3a0-0000-7000-8000-000000000001";
export const OTHER_INSTALLATION_ID = "0192d3a0-0000-7000-8000-000000000002";
export const RESOURCE = installationResource(ISSUER, INSTALLATION_ID);

export function installationEndpoints({ limit = NO_RATE_LIMIT }: { limit?: AppRateLimit } = {}) {
  const base = endpoints();
  const installation: { current: TokenInstallation | undefined } = {
    current: {
      id: INSTALLATION_ID,
      appId: CLIENT.id,
      appKey: CLIENT.key,
      workspaceId: "ws-acme",
      workspaceSlug: "acme",
      declared: ["workspace", "agent", "channel"] as AppPermissionGroup[],
      approved: ["workspace", "agent"] as AppPermissionGroup[],
    },
  };
  const other: TokenInstallation = {
    ...installation.current!,
    id: OTHER_INSTALLATION_ID,
    appId: "app-2",
    appKey: "other-app",
  };
  const flag = { on: true };
  const installationTokens = new InstallationTokens(
    {
      async findInstallation(id) {
        if (id === OTHER_INSTALLATION_ID) return other;
        return id === INSTALLATION_ID && installation.current
          ? { ...installation.current }
          : undefined;
      },
    },
    async () => flag.on,
    { issuer: ISSUER, signingKeys: SIGNING_KEYS },
  );
  const tokenEndpoint = new TokenEndpoint(base.store, base.options, installationTokens, limit);
  return { ...base, tokenEndpoint, installationTokens, installation, flag };
}

/** A `client_credentials` request, by default a correct one asking for the approved groups. */
export function credentialsRequest({
  form = {},
  authorization = basic(CLIENT.key, CLIENT.secret),
}: {
  form?: Record<string, string | undefined>;
  authorization?: string | null;
} = {}): Request {
  const fields = Object.entries({
    grant_type: "client_credentials",
    resource: RESOURCE,
    scope: "installation:workspace installation:agent",
    ...form,
  }).filter((entry): entry is [string, string] => entry[1] !== undefined);
  return new Request(`${ISSUER}/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(authorization ? { authorization } : {}),
    },
    body: new URLSearchParams(fields).toString(),
  });
}
