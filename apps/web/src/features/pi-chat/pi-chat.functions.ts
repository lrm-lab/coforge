import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { piChatCommandSchema, supportsWorkbenchCodex } from "@lrm/coforge-sdk/internal/pi-chat";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { declareNoStore } from "#src/features/no-store-response.server";
import { isAiWorkbenchEnabled, requireAiWorkbench } from "#src/server/pi-chat/ai-workbench.server";
import {
  getPiChatControlsLease,
  getPiChatFilesLease,
  getWorkbenchCodexLease,
} from "#src/server/pi-chat/pi-chat-capability.server";
import {
  piChatConfiguration,
  productionPiChat,
} from "#src/server/pi-chat/pi-chat-production.server";

/** Whether the viewer's Workspace has AI Workbench on; any member may ask, only the answer. */
export const loadAiWorkbenchOn = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    declareNoStore();
    return isAiWorkbenchEnabled(context.db, context.workspaceId);
  });

export const getPiChatComputers = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    declareNoStore();
    await requireAiWorkbench(context.db, context.workspaceId);
    const computers = await context.db.computer.findMany({
      where: {
        ownerId: context.user.id,
        deletedAt: null,
        workspaces: { some: { workspaceId: context.workspaceId } },
      },
      select: {
        id: true,
        displayName: true,
        name: true,
        kind: true,
        runtimes: {
          where: { workspaceId: context.workspaceId, provider: RUNTIME_PROVIDER.CODEX },
          select: { unavailableCode: true, version: true },
        },
      },
      orderBy: [{ cloudSlot: "asc" }, { id: "asc" }],
    });
    return {
      workspaceId: context.workspaceId,
      userId: context.user.id,
      configured: !!piChatConfiguration(),
      computers: (
        await Promise.all(
          computers.map(async (computer) => {
            const pi = computer.kind === "cloud";
            const codex = computer.runtimes.length > 0;
            const usableCodex = computer.runtimes.some(
              (runtime) => !runtime.unavailableCode && supportsWorkbenchCodex(runtime.version),
            );
            if (!pi && !codex) return undefined;
            const supported = async (lease: typeof getPiChatFilesLease) =>
              piChatConfiguration() &&
              (await lease()
                .supports(context.workspaceId, computer.id)
                .catch(() => false));
            const [files, controls, codexOnline] = await Promise.all([
              pi && supported(getPiChatFilesLease),
              pi && supported(getPiChatControlsLease),
              usableCodex && supported(getWorkbenchCodexLease),
            ]);
            return {
              id: computer.id,
              name: computer.displayName || computer.name,
              pi,
              codex,
              codexOnline,
              files,
              controls,
            };
          }),
        )
      ).filter((computer) => computer !== undefined),
    };
  });

/** Publishes one command to the Computer's daemon and answers at once with the id its reply is
 * read by (`readPiChat`): production closes a request that sends nothing for about ten seconds. */
export const startPiChat = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ computerId: z.uuid(), command: piChatCommandSchema }))
  .handler(async ({ context, data }) => {
    declareNoStore();
    await requireAiWorkbench(context.db, context.workspaceId);
    return productionPiChat(context.db).start(
      { userId: context.user.id, workspaceId: context.workspaceId },
      data.computerId,
      data.command,
    );
  });

/** The daemon's reply to a command this caller started, authorized as the start is whenever it holds a reply. */
export const readPiChat = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ computerId: z.uuid(), requestId: z.uuid() }))
  .handler(async ({ context, data }) => {
    declareNoStore();
    return productionPiChat(context.db).read(
      { userId: context.user.id, workspaceId: context.workspaceId },
      data.computerId,
      data.requestId,
    );
  });
