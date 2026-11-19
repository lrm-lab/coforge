import { encodeRuntimeManageRequest } from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import { getComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import { getRuntimeManageResults } from "#src/server/centrifugo/runtime-manage-results.server";
import {
  createCentrifugoServerApi,
  daemonControlChannel,
  daemonOnline,
} from "#src/server/centrifugo/server-api.server";
import { ComputerRuntimeManage } from "./computer-runtime-manage.server";
import { PrismaRuntimeAuthAuthorization } from "./runtime-auth-authorization.server";
import { getRuntimeManageCapabilityLease } from "./runtime-manage-capability.server";

export function computerRuntimeManage(
  db: Pick<PrismaClient, "workspaceComputer" | "computerRuntime">,
) {
  const authorization = new PrismaRuntimeAuthAuthorization(db);
  return new ComputerRuntimeManage({
    authorized: (viewer, computerId) =>
      authorization.canManage({
        userId: viewer.userId,
        workspaceId: viewer.workspaceId,
        computerId,
      }),
    online: (scope) =>
      daemonOnline(() => createCentrifugoServerApi(), getComputerStatusCache())(scope),
    supported: ({ workspaceId, computerId }) =>
      getRuntimeManageCapabilityLease().supports(workspaceId, computerId),
    publish: (request) =>
      createCentrifugoServerApi().publish(
        daemonControlChannel(request.workspaceId, request.computerId),
        encodeRuntimeManageRequest(request),
      ),
    results: {
      begin: (pending) => getRuntimeManageResults().begin(pending),
      read: (requestId) => getRuntimeManageResults().read(requestId),
      clear: (requestId) => getRuntimeManageResults().clear(requestId),
    },
  });
}
