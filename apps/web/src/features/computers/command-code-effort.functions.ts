import { createServerFn } from "@tanstack/react-start";
import {
  encodeDaemonRuntimeCommandCodeEffortReadRequest,
  RUNTIME_PROVIDER,
} from "@lrm/coforge-sdk/internal";
import { declareNoStore } from "#src/features/no-store-response.server";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import {
  createCentrifugoServerApi,
  daemonControlChannel,
} from "#src/server/centrifugo/server-api.server";
import { getCommandCodeEffortResults } from "#src/server/centrifugo/command-code-effort-cache.server";
import { CommandCodeEffortRead } from "#src/server/computers/command-code-effort-read.server";
import { ComputerRuntimeVisibility } from "#src/server/computers/computer-runtime-visibility.server";
import { PrismaComputerRuntimeRepository } from "#src/server/db/repositories/computer-runtime.repositories.server";
import { readCommandCodeEffortsInputSchema } from "./computer.schemas";

/** Asks this Computer for one Command Code model's effort choices. */
export const readCommandCodeReasoningEfforts = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(readCommandCodeEffortsInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    declareNoStore();
    const connection = await db.workspaceComputer.findUnique({
      where: { workspaceId_computerId: { workspaceId, computerId: data.computerId } },
      select: { computerId: true },
    });
    if (!connection) throw new Error("Computer is not available");
    const api = createCentrifugoServerApi();
    const visibility = new ComputerRuntimeVisibility(new PrismaComputerRuntimeRepository(db));
    return new CommandCodeEffortRead({
      authorize: ({ userId, workspaceId: principalWorkspaceId }, computerId) =>
        visibility.canSelect(
          { workspaceId: principalWorkspaceId, userId },
          computerId,
          RUNTIME_PROVIDER.COMMAND_CODE,
        ),
      results: getCommandCodeEffortResults(),
      publish: (request) =>
        api.publish(
          daemonControlChannel(workspaceId, data.computerId),
          encodeDaemonRuntimeCommandCodeEffortReadRequest(request),
        ),
    }).execute({ userId: user.id, workspaceId }, data.computerId, data.modelId);
  });
