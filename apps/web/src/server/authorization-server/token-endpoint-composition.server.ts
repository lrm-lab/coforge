import type { PrismaClient } from "#src/generated/prisma/client";
import { getAppRateLimits } from "#src/server/app-rate-limits/app-rate-limits-composition.server";
import { requireDatabaseClient } from "#src/server/db/client.server";
import { createAppInstallationSetup } from "#src/server/app-installation-setup/app-installation-setup-composition.server";
import { PrismaGrantStore } from "#src/server/db/repositories/oauth-grant.repositories.server";
import {
  createAgentEvents,
  createAppAgentInbound,
  type AgentEventPush,
} from "#src/server/app-agent-events/app-agent-events-composition.server";
import { PrismaAppAgentInboundStore } from "#src/server/db/repositories/app-agent-inbound.repositories.server";
import { PrismaAppPermissionsStore } from "#src/server/db/repositories/app-permissions.repositories.server";
import { isFeatureEnabled } from "#src/server/feature-flags/feature-flags.server";
import { AgentInboundEndpoint } from "./agent-inbound-endpoint.server";
import { AgentInboundTokens } from "./agent-inbound-tokens.server";
import { authorizationServerConfiguration } from "./configuration.server";
import { InstallationTokens } from "./installation-tokens.server";
import type { SigningKey } from "./signing-keys.server";
import { SetupEndpoint } from "./setup-endpoint.server";
import { TokenEndpoint } from "./token-endpoint.server";
import { UserInfoEndpoint } from "./userinfo-endpoint.server";

/** The token, UserInfo, installation setup and Agent inbound endpoints over PostgreSQL, signing with
 * `signingKeys`, and the installation tokens the token endpoint issues and an API verifies. */
export function createTokenEndpoints({
  issuer,
  signingKeys,
  db = requireDatabaseClient(),
  now,
  agentEventPush,
}: {
  issuer: string;
  signingKeys: SigningKey[];
  db?: PrismaClient;
  now?: () => Date;
  /** Where an accepted Agent event's delivery is pushed; default Centrifugo. */
  agentEventPush?: AgentEventPush;
}): {
  token: TokenEndpoint;
  userInfo: UserInfoEndpoint;
  installationTokens: InstallationTokens;
  setup: SetupEndpoint;
  agentInbound: AgentInboundEndpoint;
} {
  const store = new PrismaGrantStore(db);
  const options = { issuer, signingKeys, ...(now ? { now } : {}) };
  const installationTokens = new InstallationTokens(
    new PrismaAppPermissionsStore(db),
    isFeatureEnabled,
    options,
  );
  const limits = getAppRateLimits();
  const agentInboundTokens = new AgentInboundTokens(
    new PrismaAppAgentInboundStore(db),
    (workspace) => isFeatureEnabled("app-agent-events", workspace),
    options,
  );
  return {
    token: new TokenEndpoint(store, options, installationTokens, limits.token, agentInboundTokens),
    userInfo: new UserInfoEndpoint(store, options),
    installationTokens,
    setup: new SetupEndpoint(installationTokens, createAppInstallationSetup(db), store, options),
    agentInbound: new AgentInboundEndpoint(
      createAppAgentInbound(db),
      createAgentEvents(db, agentEventPush ? { push: agentEventPush } : {}),
      agentInboundTokens,
      store,
      { requests: limits.token, events: limits.installation },
      options,
    ),
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
