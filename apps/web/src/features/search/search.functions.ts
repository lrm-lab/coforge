import { createServerFn } from "@tanstack/react-start";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { readDeadline } from "#src/lib/read-deadline";
import { productionArtifacts } from "#src/server/artifacts/artifact-composition.server";
import { searchMessages } from "#src/server/conversations/message-search.server";
import { searchTasks } from "#src/server/tasks/task-search.server";
import {
  artifactSearchInputSchema,
  messageSearchInputSchema,
  taskSearchInputSchema,
} from "./search.schemas";

const ARTIFACT_SEARCH_LIMIT = 5;

export const searchWorkspaceMessages = createServerFn({ method: "GET" })
  .middleware([readDeadline(30_000), workspaceUserMiddleware])
  .validator(messageSearchInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    return searchMessages(db, {
      ...data,
      workspaceId,
      userId: user.id,
      after: data.after ? new Date(data.after) : undefined,
      before: data.before ? new Date(data.before) : undefined,
    });
  });

export const searchWorkspaceTasks = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(taskSearchInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    return searchTasks(db, { ...data, workspaceId, userId: user.id });
  });

export const searchWorkspaceArtifacts = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(artifactSearchInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    if (!data.query.trim()) return [];
    const page = await productionArtifacts(db).gallery.page({
      workspaceId,
      userId: user.id,
      query: data.query,
      scope: data.conversationId
        ? { kind: "conversation", conversationId: data.conversationId }
        : undefined,
      sort: "updated",
      limit: ARTIFACT_SEARCH_LIMIT,
    });
    return page.artifacts.map(({ id, title, entryPath, currentVersion }) => ({
      id,
      title,
      entryPath,
      currentVersion,
    }));
  });
