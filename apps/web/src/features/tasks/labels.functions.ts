import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { announceLabelChanged } from "#src/server/tasks/label-signal.server";
import { LABEL_COLORS, LABEL_NAME_MAX, Labels } from "#src/server/tasks/labels.server";

const labelName = z.string().trim().min(1).max(LABEL_NAME_MAX);
const labelColor = z.enum(LABEL_COLORS);

/** The Workspace's labels, for the task card and its label picker. Any member may read them. */
export const loadWorkspaceLabels = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    const { user, db, workspaceId } = context;
    return new Labels(db).list(workspaceId, user.id);
  });

/** Creates a label; a name that already exists (in any case) returns that label. Any member. */
export const createTaskLabel = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ name: labelName, color: labelColor.optional() }).strict())
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    const label = await new Labels(db).create(workspaceId, user.id, data);
    await announceLabelChanged(createCentrifugoServerApi(), workspaceId, { label });
    return label;
  });

/** Renames or recolors a label; an owner or admin only. */
export const updateTaskLabel = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({ id: z.uuid(), name: labelName.optional(), color: labelColor.optional() }).strict(),
  )
  .handler(async ({ context, data }) => {
    const { id, ...input } = data;
    const { user, db, workspaceId } = context;
    const label = await new Labels(db).update(workspaceId, user.id, id, input);
    await announceLabelChanged(createCentrifugoServerApi(), workspaceId, { label });
    return label;
  });

/** Deletes a label from every task; an owner or admin only. */
export const deleteTaskLabel = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ id: z.uuid() }).strict())
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    await new Labels(db).delete(workspaceId, user.id, data.id);
    await announceLabelChanged(createCentrifugoServerApi(), workspaceId, {
      label: null,
      deletedLabelId: data.id,
    });
  });
