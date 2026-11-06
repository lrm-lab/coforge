import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { AppError } from "#src/lib/app-error";
import { workspaceMemberRole } from "#src/server/workspaces/workspace-membership.server";
import { UsageLimitEvents } from "#src/server/usage-limits/usage-limit-events.server";

const eventInputSchema = z.object({ eventId: z.string().uuid() });

/** The Workspace's open usage-limit events with the viewer's own seen/dismiss marks —
 * owner/admin only; every other role is refused. */
export const getUsageLimitEvents = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) =>
    new UsageLimitEvents(context.db).listForViewer(
      context.workspaceId,
      context.user.id,
      await workspaceMemberRole(context.db, context.workspaceId, context.user.id),
    ),
  );

/** Marks one event seen for this owner/admin. */
export const seenUsageLimitEvent = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(eventInputSchema)
  .handler(async ({ data, context }) => {
    const marked = await new UsageLimitEvents(context.db).markSeen(
      context.workspaceId,
      context.user.id,
      await workspaceMemberRole(context.db, context.workspaceId, context.user.id),
      data.eventId,
    );
    if (!marked) throw new AppError("NOT_FOUND");
  });

/** Dismisses one event for this owner/admin until it closes. */
export const dismissUsageLimitEvent = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(eventInputSchema)
  .handler(async ({ data, context }) => {
    const dismissed = await new UsageLimitEvents(context.db).dismiss(
      context.workspaceId,
      context.user.id,
      await workspaceMemberRole(context.db, context.workspaceId, context.user.id),
      data.eventId,
    );
    if (!dismissed) throw new AppError("NOT_FOUND");
  });
