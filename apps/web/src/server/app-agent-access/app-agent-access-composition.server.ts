import type { PrismaClient } from "#src/generated/prisma/client";
import { AgentAppUse } from "#src/server/app-agent-access/agent-app-use.server";
import { listAgentLaunchApps } from "#src/server/app-agent-access/agent-launch-apps.server";
import { AppAgentAccess } from "#src/server/app-agent-access/app-agent-access.server";
import { InstallationAgentScope } from "#src/server/app-agent-access/installation-agent-scope.server";
import {
  authorizationServerConfiguration,
  type AuthorizationServerConfiguration,
} from "#src/server/authorization-server/configuration.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { AppGrantCards } from "#src/server/conversations/app-grant-cards.server";
import {
  CentrifugoConversationRealtime,
  type ConversationRealtime,
} from "#src/server/conversations/conversation-realtime.server";
import { PrismaAppAgentAccessStore } from "#src/server/db/repositories/app-agent-access.repositories.server";
import { PrismaInstallationAgentScopeStore } from "#src/server/db/repositories/app-installation-agent-scope.repositories.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";

/** Agents' app access over PostgreSQL; a decided request's approval card is refreshed through
 * `realtime`. */
export function createAppAgentAccess(
  db: PrismaClient,
  { realtime = centrifugoRealtime }: { realtime?: () => ConversationRealtime | undefined } = {},
) {
  return appAgentAccess(db, appGrantCards(db, realtime));
}

const appGrantCards = (db: PrismaClient, realtime: () => ConversationRealtime | undefined) =>
  new AppGrantCards(db, new PrismaDirectConversationRepository(db), realtime);

const appAgentAccess = (db: PrismaClient, cards: AppGrantCards) =>
  new AppAgentAccess(new PrismaAppAgentAccessStore(db), (workspaceId, requestId) =>
    cards.publishDecided(workspaceId, requestId),
  );

/** The browser publication of a posted approval card; none when Centrifugo is not configured,
 * since browsers reconcile a missed one. */
function centrifugoRealtime(): ConversationRealtime | undefined {
  try {
    return new CentrifugoConversationRealtime(createCentrifugoServerApi());
  } catch {
    return undefined;
  }
}

/** An Agent's use of its Workspace's apps over PostgreSQL, with the authorization server the boot
 * configured (or `issuer`). */
export function createAgentAppUse(
  db: PrismaClient,
  {
    issuer = authorizationServerConfiguration,
    realtime = centrifugoRealtime,
  }: {
    issuer?: () => AuthorizationServerConfiguration;
    realtime?: () => ConversationRealtime | undefined;
  } = {},
) {
  const cards = appGrantCards(db, realtime);
  return new AgentAppUse({
    access: appAgentAccess(db, cards),
    cards,
    issuer,
    workspaceSlug: async (workspaceId) =>
      (
        await db.workspace.findUniqueOrThrow({
          where: { id: workspaceId },
          select: { slug: true },
        })
      ).slug,
  });
}

/** The apps installed in the Workspace that the Agent is told about, over PostgreSQL, for its
 * launch identity. */
export function agentLaunchApps(db: PrismaClient, workspaceId: string, agentId: string) {
  return listAgentLaunchApps(new PrismaAppAgentAccessStore(db), workspaceId, agentId);
}

/** Which Agents may use an installed app, over PostgreSQL; a request its change settles has its
 * approval card refreshed through `realtime`. */
export function createInstallationAgentScope(
  db: PrismaClient,
  { realtime = centrifugoRealtime }: { realtime?: () => ConversationRealtime | undefined } = {},
) {
  const cards = appGrantCards(db, realtime);
  return new InstallationAgentScope(new PrismaInstallationAgentScopeStore(db), (workspaceId, id) =>
    cards.publishDecided(workspaceId, id),
  );
}
