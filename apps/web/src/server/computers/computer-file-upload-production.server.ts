import { encodeComputerFilePullRequest } from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import { getComputerFilePullResults } from "#src/server/centrifugo/computer-file-upload-results.server";
import { getComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import {
  createCentrifugoServerApi,
  daemonControlChannel,
} from "#src/server/centrifugo/server-api.server";
import { getFileStorage } from "#src/server/files/file-storage.server";
import { ComputerFileUploads } from "./computer-file-upload.server";
import { getComputerFileUploadCapabilityLease } from "./computer-file-upload-capability.server";
import { getComputerFileUploadSessions } from "./computer-file-upload-sessions.server";

/** Production composition for owner uploads that land in a Computer's uploads directory. */
export async function computerFileUploads(db: Pick<PrismaClient, "computer">) {
  const centrifugo = createCentrifugoServerApi();
  const storage = await getFileStorage();
  return new ComputerFileUploads({
    owned: async (viewer, computerId) =>
      Boolean(
        await db.computer.findFirst({
          where: {
            id: computerId,
            ownerId: viewer.userId,
            deletedAt: null,
            workspaces: { some: { workspaceId: viewer.workspaceId } },
          },
          select: { id: true },
        }),
      ),
    online: (scope) => getComputerStatusCache().get(scope),
    supported: ({ workspaceId, computerId }) =>
      getComputerFileUploadCapabilityLease().supports(workspaceId, computerId),
    storage,
    sessions: getComputerFileUploadSessions(),
    pullResults: getComputerFilePullResults(),
    publishPull: (request) =>
      centrifugo.publish(
        daemonControlChannel(request.workspaceId, request.computerId),
        encodeComputerFilePullRequest(request),
      ),
  });
}
