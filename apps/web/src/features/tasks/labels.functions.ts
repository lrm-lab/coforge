import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import {
  announceLabelChanged,
  announceLabelGroupChanged,
} from "#src/server/tasks/label-signal.server";
import { LABEL_COLORS, LABEL_NAME_MAX, Labels } from "#src/server/tasks/labels.server";
import { canManageWorkspaceSettings } from "#src/features/workspaces/workspace-roles";
import { workspaceMemberRole } from "#src/server/workspaces/workspace-membership.server";
import { LABEL_GROUP_SELECTIONS, LabelGroups } from "#src/server/tasks/label-groups.server";
import { labelUpdateInput } from "#src/server/tasks/label-update-input.server";

const labelName = z.string().trim().min(1).max(LABEL_NAME_MAX);
const labelColor = z.enum(LABEL_COLORS);

/**
 * The Workspace's labels, for the task card and its label picker, and whether the viewer may
 * recolor them (an owner or admin, as `Labels.update` decides). Any member may read the labels.
 */
export const loadWorkspaceLabels = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    const { user, db, workspaceId } = context;
    const labels = await new Labels(db).list(workspaceId, user.id);
    const role = await workspaceMemberRole(db, workspaceId, user.id);
    return { labels, canManage: canManageWorkspaceSettings(role) };
  });

/**
 * Settings → Labels (task #508): every label, the archived ones too, with how many Tasks carry it
 * and when it was last put on one, and whether the viewer manages them. Any member may read it.
 */
export const loadLabelSettings = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    const { user, db, workspaceId } = context;
    const labels = await new Labels(db).list(workspaceId, user.id, { archived: true });
    const role = await workspaceMemberRole(db, workspaceId, user.id);
    return { labels, canManage: canManageWorkspaceSettings(role) };
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

/** Renames, recolors or archives a label (archiving takes it off every Task); an owner or admin only. */
export const updateTaskLabel = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(labelUpdateInput)
  .handler(async ({ context, data }) => {
    const { id, ...input } = data;
    const { user, db, workspaceId } = context;
    const label = await new Labels(db).update(workspaceId, user.id, id, input);
    await announceLabelChanged(createCentrifugoServerApi(), workspaceId, { label });
    return label;
  });

/** Deletes an archived label for good, from every task; an owner or admin only (a live label is
 * archived first, `Labels.delete`). */
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

const groupName = z.string().trim().min(1).max(LABEL_NAME_MAX);
const groupSelection = z.enum(LABEL_GROUP_SELECTIONS);

/** The Workspace's label groups, for the picker's grouping. Any member may read them. */
export const loadWorkspaceLabelGroups = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    const { user, db, workspaceId } = context;
    return new LabelGroups(db).list(workspaceId, user.id);
  });

/** Creates a group (default single); a name that already exists returns that group. Any member. */
export const createLabelGroup = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ name: groupName, selection: groupSelection.optional() }).strict())
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    const group = await new LabelGroups(db).create(workspaceId, user.id, data);
    await announceLabelGroupChanged(createCentrifugoServerApi(), workspaceId, { group });
    return group;
  });

/** Renames a group or changes its selection; an owner or admin only. */
export const updateLabelGroup = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z
      .object({ id: z.uuid(), name: groupName.optional(), selection: groupSelection.optional() })
      .strict(),
  )
  .handler(async ({ context, data }) => {
    const { id, ...input } = data;
    const { user, db, workspaceId } = context;
    const result = await new LabelGroups(db).update(workspaceId, user.id, id, input);
    await announceLabelGroupChanged(createCentrifugoServerApi(), workspaceId, {
      group: result.group,
    });
    return result;
  });

/** Deletes a group; its labels stay, ungrouped. An owner or admin only. */
export const deleteLabelGroup = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ id: z.uuid() }).strict())
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    await new LabelGroups(db).delete(workspaceId, user.id, data.id);
    await announceLabelGroupChanged(createCentrifugoServerApi(), workspaceId, {
      group: null,
      deletedGroupId: data.id,
    });
  });
