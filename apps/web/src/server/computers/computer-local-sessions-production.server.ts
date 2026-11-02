import {
  encodeLocalSessionExcerptRequest,
  encodeLocalSessionSearchRequest,
} from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import {
  getLocalSessionExcerptResults,
  getLocalSessionSearchResults,
} from "#src/server/centrifugo/local-session-results.server";
import { getComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import {
  createCentrifugoServerApi,
  daemonControlChannel,
} from "#src/server/centrifugo/server-api.server";
import { ComputerLocalSessions } from "./computer-local-sessions.server";

/** Production composition for owner-only local-session observations on one local Computer. */
export function computerLocalSessions(db: Pick<PrismaClient, "computer">) {
  const centrifugo = createCentrifugoServerApi();
  return new ComputerLocalSessions({
    owned: async (viewer, computerId) =>
      Boolean(
        await db.computer.findFirst({
          where: {
            id: computerId,
            ownerId: viewer.userId,
            kind: "local",
            deletedAt: null,
            workspaces: { some: { workspaceId: viewer.workspaceId } },
          },
          select: { id: true },
        }),
      ),
    online: (scope) => getComputerStatusCache().get(scope),
    publishSearch: (request) =>
      centrifugo.publish(
        daemonControlChannel(request.workspaceId, request.computerId),
        encodeLocalSessionSearchRequest(request),
      ),
    publishExcerpt: (request) =>
      centrifugo.publish(
        daemonControlChannel(request.workspaceId, request.computerId),
        encodeLocalSessionExcerptRequest(request),
      ),
    searchResults: getLocalSessionSearchResults(),
    excerptResults: getLocalSessionExcerptResults(),
  });
}
