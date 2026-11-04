import type { PrismaClient as Database } from "#src/generated/prisma/client";
import { AgentDeletion } from "#src/server/agents/agent-deletion.server";
import { PrismaAgentDeletionStore } from "#src/server/db/repositories/agent-deletion.repositories.server";
import { PrismaAgentRepository } from "#src/server/db/repositories/agent.repositories.server";
import { ChangeAgentVisibility } from "#src/server/agents/change-agent-visibility.server";
import { PrismaChangeAgentVisibilityStore } from "#src/server/db/repositories/agent-visibility-change.repositories.server";
import { AgentInboxPurgePublisher } from "#src/server/agents/agent-inbox-purge.server";
import { userAgentRuntimeControl } from "#src/server/agents/user-agent-control.server";
import { getAgentRuntimeLock } from "#src/server/agents/agent-runtime-lock.server";
import { publishAgentVisibilityChanged } from "#src/server/agents/agent-visibility-realtime.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { announceMessageBestEffort } from "#src/server/conversations/conversation-activity.server";

let realtime: CentrifugoConversationRealtime | undefined;
/** The open-page publication a membership record announces through; none when Centrifugo is not
 * configured — a page reconciles a missed record on its next subscribe. */
function centrifugoRealtime() {
  if (!realtime) {
    try {
      realtime = new CentrifugoConversationRealtime(createCentrifugoServerApi());
    } catch {
      return undefined;
    }
  }
  return realtime;
}

/** Agent deletion and visibility-change compositions; the membership records these write announce
 * to open pages through `announceMessageBestEffort`, best effort after the commit. */
export function agentDeletion(db: Database) {
  const agents = new PrismaAgentRepository(db);
  return new AgentDeletion(
    agents,
    new PrismaAgentDeletionStore(db),
    userAgentRuntimeControl(db, agents),
    getAgentRuntimeLock(),
    undefined,
    undefined,
    (notice) => announceMessageBestEffort(db, centrifugoRealtime(), notice),
  );
}

export function changeAgentVisibilityUseCase(db: Database) {
  return new ChangeAgentVisibility(
    new PrismaAgentRepository(db),
    new PrismaChangeAgentVisibilityStore(db),
    publishAgentVisibilityChanged,
    new AgentInboxPurgePublisher(db),
    undefined,
    (notice) => announceMessageBestEffort(db, centrifugoRealtime(), notice),
  );
}
