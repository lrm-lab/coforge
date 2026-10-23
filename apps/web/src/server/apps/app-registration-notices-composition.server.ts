import type { PrismaClient } from "#src/generated/prisma/client";
import { getAppRegistrationNoticeCapabilityLease } from "#src/server/apps/app-registration-notice-capability.server";
import { AppRegistrationNotices } from "#src/server/apps/app-registration-notices.server";
import {
  createCentrifugoServerApi,
  daemonControlChannel,
} from "#src/server/centrifugo/server-api.server";

/** The private notice of a new app's client secret to its owner Agent's daemon. */
export function createAppRegistrationNotices(
  db: PrismaClient,
  centrifugo = createCentrifugoServerApi(),
) {
  return new AppRegistrationNotices(
    async (agentId) =>
      (await db.agent.findFirst({
        where: { id: agentId, deletedAt: null },
        select: { workspaceId: true, computerId: true },
      })) ?? undefined,
    getAppRegistrationNoticeCapabilityLease(),
    (workspaceId, computerId, payload) =>
      centrifugo.publish(daemonControlChannel(workspaceId, computerId), payload),
  );
}
