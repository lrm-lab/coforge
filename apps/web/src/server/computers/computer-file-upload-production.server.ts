import { encodeComputerFilePullRequest } from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import { getComputerFilePullResults } from "#src/server/centrifugo/computer-file-upload-results.server";
import { getComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import {
  createCentrifugoServerApi,
  daemonControlChannel,
  daemonOnline,
} from "#src/server/centrifugo/server-api.server";
import { getFileStorage } from "#src/server/files/file-storage.server";
import { ComputerFileUploads } from "./computer-file-upload.server";
import { getComputerFileUploadCapabilityLease } from "./computer-file-upload-capability.server";
import { getComputerFileUploadStatuses } from "./computer-file-upload-statuses.server";

/** Production composition for owner uploads that land in a Computer's uploads directory. */
export async function computerFileUploads(db: Pick<PrismaClient, "computer">) {
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
    online: daemonOnline(() => createCentrifugoServerApi(), getComputerStatusCache()),
    supported: ({ workspaceId, computerId }) =>
      getComputerFileUploadCapabilityLease().supports(workspaceId, computerId),
    storage,
    statuses: getComputerFileUploadStatuses(),
    pullResults: getComputerFilePullResults(),
    // Made on use: reading an upload needs neither the API nor its environment.
    publishPull: (request) =>
      createCentrifugoServerApi().publish(
        daemonControlChannel(request.workspaceId, request.computerId),
        encodeComputerFilePullRequest(request),
      ),
  });
}
