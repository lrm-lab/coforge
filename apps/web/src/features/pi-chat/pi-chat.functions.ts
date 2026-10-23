import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { piChatCommandSchema } from "@lrm/coforge-sdk/internal/pi-chat";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { declareNoStore } from "#src/features/no-store-response.server";
import {
  getPiChatControlsLease,
  getPiChatFilesLease,
} from "#src/server/pi-chat/pi-chat-capability.server";
import {
  piChatConfiguration,
  productionPiChat,
} from "#src/server/pi-chat/pi-chat-production.server";

export const getPiChatComputers = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    declareNoStore();
    const computers = await context.db.computer.findMany({
      where: {
        ownerId: context.user.id,
        kind: "cloud",
        deletedAt: null,
        workspaces: { some: { workspaceId: context.workspaceId } },
      },
      select: { id: true, displayName: true, name: true },
      orderBy: [{ cloudSlot: "asc" }, { id: "asc" }],
    });
    return {
      workspaceId: context.workspaceId,
      userId: context.user.id,
      configured: !!piChatConfiguration(),
      computers: await Promise.all(
        computers.map(async (computer) => ({
          id: computer.id,
          name: computer.displayName || computer.name,
          files: piChatConfiguration()
            ? await getPiChatFilesLease()
                .supports(context.workspaceId, computer.id)
                .catch(() => false)
            : false,
          controls: piChatConfiguration()
            ? await getPiChatControlsLease()
                .supports(context.workspaceId, computer.id)
                .catch(() => false)
            : false,
        })),
      ),
    };
  });

export const executePiChat = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ computerId: z.uuid(), command: piChatCommandSchema }))
  .handler(async ({ context, data }) => {
    declareNoStore();
    return productionPiChat(context.db).execute(
      { userId: context.user.id, workspaceId: context.workspaceId },
      data.computerId,
      data.command,
    );
  });
