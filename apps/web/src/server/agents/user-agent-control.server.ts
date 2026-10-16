import type { PrismaClient } from "#src/generated/prisma/client";
import { AgentControl } from "./agent-control.server";
import { PublishAgentRuntimeControl } from "./agent-runtime-control.server";
import {
  RepositoryAgentAuthorization,
  type PrismaAgentRepository,
} from "#src/server/db/repositories/agent.repositories.server";
import { getAgentControlSignal } from "./agent-control-signal.server";
import { getAgentRuntimeLock } from "./agent-runtime-lock.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { MentionDeliveryReports } from "#src/server/conversations/mention-deliveries.server";
import { PrismaAgentControlStore } from "#src/server/db/repositories/agent-control.repositories.server";
import { createAgentSessions } from "#src/server/db/repositories/agent-session.repositories.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { PrismaMentionDeliveryRepository } from "#src/server/db/repositories/mention-delivery.repositories.server";

/** The `AgentControl` a signed-in user's Start, Stop, Restart and Reset go through. */
export function userAgentControl(db: PrismaClient) {
  const centrifugo = createCentrifugoServerApi();
  const conversations = new PrismaDirectConversationRepository(db);
  const mentions = new MentionDeliveryReports(
    new PrismaMentionDeliveryRepository(db),
    centrifugo,
    conversations,
  );
  return new AgentControl(
    new PrismaAgentControlStore(db),
    centrifugo,
    getAgentRuntimeLock(),
    undefined,
    createAgentSessions(db, mentions),
    getAgentControlSignal(),
    conversations,
    mentions,
  );
}

/** The runtime Start and Stop publisher an owner's Agent changes go through. */
export function userAgentRuntimeControl(db: PrismaClient, agents: PrismaAgentRepository) {
  const centrifugo = createCentrifugoServerApi();
  const conversations = new PrismaDirectConversationRepository(db);
  const mentions = new MentionDeliveryReports(
    new PrismaMentionDeliveryRepository(db),
    centrifugo,
    conversations,
  );
  const sessions = createAgentSessions(db, mentions);
  return new PublishAgentRuntimeControl(
    new RepositoryAgentAuthorization(agents),
    centrifugo,
    async () => {},
    sessions,
    new AgentControl(
      new PrismaAgentControlStore(db),
      centrifugo,
      getAgentRuntimeLock(),
      undefined,
      sessions,
      getAgentControlSignal(),
    ),
  );
}
