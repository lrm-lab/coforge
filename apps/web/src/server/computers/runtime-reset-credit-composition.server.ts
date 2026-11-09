import { encodeDaemonRuntimeResetCreditConsumeRequest } from "@lrm/coforge-sdk/internal";

import type { PrismaClient } from "#src/generated/prisma/client";
import { getComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import { getResetCreditResults } from "#src/server/centrifugo/reset-credit-cache.server";
import {
  createCentrifugoServerApi,
  daemonControlChannel,
} from "#src/server/centrifugo/server-api.server";
import { PrismaRuntimeAuthAuthorization } from "./runtime-auth-authorization.server";
import { getResetCreditCapabilityLease } from "./reset-credit-capability.server";
import { RuntimeResetCredit } from "./runtime-reset-credit.server";

/** The `RuntimeResetCredit` the signed-in user's Server Function goes through. */
export function userRuntimeResetCredit(db: Pick<PrismaClient, "workspaceComputer">) {
  return new RuntimeResetCredit({
    authorization: new PrismaRuntimeAuthAuthorization(db),
    computerStatus: getComputerStatusCache(),
    capability: getResetCreditCapabilityLease(),
    results: getResetCreditResults(),
    // Made on use: reading an answer needs neither the API nor its environment.
    publish: async (request) => {
      await createCentrifugoServerApi().publish(
        daemonControlChannel(request.workspaceId, request.computerId),
        encodeDaemonRuntimeResetCreditConsumeRequest(request),
      );
    },
  });
}
