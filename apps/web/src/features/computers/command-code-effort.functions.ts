import { createServerFn } from "@tanstack/react-start";
import {
  encodeDaemonRuntimeCommandCodeEffortReadRequest,
  RUNTIME_PROVIDER,
} from "@lrm/coforge-sdk/internal";
import { declareNoStore } from "#src/features/no-store-response.server";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import type { PrismaClient } from "#src/generated/prisma/client";
import {
  createCentrifugoServerApi,
  daemonControlChannel,
} from "#src/server/centrifugo/server-api.server";
import { getCommandCodeEffortResults } from "#src/server/centrifugo/command-code-effort-cache.server";
import { CommandCodeEffortRead } from "#src/server/computers/command-code-effort-read.server";
import { ComputerRuntimeVisibility } from "#src/server/computers/computer-runtime-visibility.server";
import { PrismaComputerRuntimeRepository } from "#src/server/db/repositories/computer-runtime.repositories.server";
import {
  readCommandCodeEffortAnswerInputSchema,
  startCommandCodeEffortReadInputSchema,
} from "./computer.schemas";

/** The read both Server Functions go through; the runtime must be selectable by the viewer. */
function commandCodeEffortRead(db: PrismaClient) {
  const visibility = new ComputerRuntimeVisibility(new PrismaComputerRuntimeRepository(db));
  return new CommandCodeEffortRead({
    authorize: ({ userId, workspaceId }, computerId) =>
      visibility.canSelect({ workspaceId, userId }, computerId, RUNTIME_PROVIDER.COMMAND_CODE),
    results: getCommandCodeEffortResults(),
    // Made on use: reading an answer needs neither the API nor its environment.
    publish: async (request) => {
      await createCentrifugoServerApi().publish(
        daemonControlChannel(request.workspaceId, request.computerId),
        encodeDaemonRuntimeCommandCodeEffortReadRequest(request),
      );
    },
  });
}

/**
 * Asks this Computer for one Command Code model's effort choices and returns at once with the
 * request to poll: production closes a request idle for about ten seconds and the Computer can
 * take about thirty. The answer is read with `readCommandCodeEffortAnswer`.
 */
export const startCommandCodeEffortRead = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(startCommandCodeEffortReadInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    declareNoStore();
    const connection = await db.workspaceComputer.findUnique({
      where: { workspaceId_computerId: { workspaceId, computerId: data.computerId } },
      select: { computerId: true },
    });
    if (!connection) throw new Error("Computer is not available");
    return commandCodeEffortRead(db).start({ userId: user.id, workspaceId }, data);
  });

/** The Computer's answer to a started read: pending, the efforts, or a failure. */
export const readCommandCodeEffortAnswer = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(readCommandCodeEffortAnswerInputSchema)
  .handler(async ({ context, data }) => {
    declareNoStore();
    return commandCodeEffortRead(context.db).read(
      { userId: context.user.id, workspaceId: context.workspaceId },
      data,
    );
  });
