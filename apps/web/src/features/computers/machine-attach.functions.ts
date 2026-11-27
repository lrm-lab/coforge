import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware, workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { declareNoStore } from "#src/features/no-store-response.server";
import { requireDatabaseClient } from "#src/server/db/client.server";
import { decideComputerAttachSession } from "#src/server/computers/computer-attach-session.server";
import {
  listMachineAttachRequests,
  readMachineAttachApproval,
} from "#src/server/computers/computer-attach-visibility.server";

const sessionInput = z.object({ sessionId: z.uuid() });
const decisionInput = sessionInput.extend({
  workspaceId: z.uuid(),
  userCode: z.string().trim().length(8),
  action: z.enum(["approve", "deny"]),
});

export const readMachineAttach = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(sessionInput)
  .handler(({ data, context }) => {
    declareNoStore();
    return readMachineAttachApproval(requireDatabaseClient(), data.sessionId, context.user.id);
  });

export const decideMachineAttach = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(decisionInput)
  .handler(async ({ data, context }) => {
    declareNoStore();
    const accepted = await decideComputerAttachSession(requireDatabaseClient(), {
      ...data,
      userId: context.user.id,
    });
    return { accepted };
  });

export const listMachineAttach = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(({ context: { db, workspaceId, user } }) => {
    declareNoStore();
    return listMachineAttachRequests(db, workspaceId, user.id);
  });
