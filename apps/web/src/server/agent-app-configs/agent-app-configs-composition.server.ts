import { encodeAppConfigSync } from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import { AgentAppConfigs } from "#src/server/agent-app-configs/agent-app-configs.server";
import { getAppConfigCapabilityLease } from "#src/server/agent-app-configs/app-config-capability.server";
import {
  createCentrifugoServerApi,
  daemonControlChannel,
} from "#src/server/centrifugo/server-api.server";
import { PrismaAgentAppConfigRepository } from "#src/server/db/repositories/agent-app-config.repositories.server";

/** Agent App configuration over PostgreSQL, pushing each change on the daemon control channel of
 * the Computer running the Agent. Shared by the Agent HTTP route and the daemon RPC handler. */
export function createAgentAppConfigs(db: PrismaClient, centrifugo = createCentrifugoServerApi()) {
  return new AgentAppConfigs(
    new PrismaAgentAppConfigRepository(db),
    getAppConfigCapabilityLease(),
    (sync) =>
      centrifugo.publish(
        daemonControlChannel(sync.workspaceId, sync.computerId),
        encodeAppConfigSync(sync),
      ),
  );
}
