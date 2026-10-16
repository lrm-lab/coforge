import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { declareNoStore } from "#src/features/no-store-response.server";
import { agentMigrationRequests } from "#src/server/agent-migrations/agent-migration-composition.server";

const agentInputSchema = z.object({ agentId: z.string().min(1).max(64) });

/** The Agent's latest move between Computers, and whether a new one can be asked for. */
export const getAgentMigration = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(agentInputSchema)
  .handler(({ data, context: { user, db, workspaceId } }) => {
    declareNoStore();
    return agentMigrationRequests(db).status({ userId: user.id, workspaceId }, data.agentId);
  });

/** The owner's request to move the Agent to another Computer of the Workspace. */
export const requestAgentMigration = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(agentInputSchema.extend({ targetComputerId: z.string().min(1).max(64) }))
  .handler(({ data, context: { user, db, workspaceId } }) => {
    declareNoStore();
    return agentMigrationRequests(db).request({ userId: user.id, workspaceId }, data);
  });

/** The owner's cancel of a move that has not finished; one that has is left as it is. */
export const cancelAgentMigration = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(agentInputSchema.extend({ migrationId: z.string().min(1).max(64) }))
  .handler(({ data, context: { user, db, workspaceId } }) => {
    declareNoStore();
    return agentMigrationRequests(db).cancel({ userId: user.id, workspaceId }, data);
  });

/** The Computers the owner could move the Agent to, with why any of them cannot take it now. */
export const listAgentMigrationTargets = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(agentInputSchema)
  .handler(({ data, context: { user, db, workspaceId } }) => {
    declareNoStore();
    return agentMigrationRequests(db).targets({ userId: user.id, workspaceId }, data.agentId);
  });
