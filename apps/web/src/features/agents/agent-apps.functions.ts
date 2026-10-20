import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import {
  workspaceUserMiddleware,
  type WorkspaceUserContext,
} from "#src/features/auth/function-auth";
import { APP_KEY_MAX_LENGTH, APP_SCOPES } from "#src/features/apps/app-registration";
import { declareNoStore } from "#src/features/no-store-response.server";
import { createAppAgentAccess } from "#src/server/app-agent-access/app-agent-access-composition.server";
import type {
  AgentAppAccessActor,
  AgentAppAccessList,
} from "#src/server/app-agent-access/app-agent-access.server";
import { agentIdSchema } from "./agent.schemas";

/**
 * The Agent profile's Apps tab. Thin wrappers over `server/app-agent-access/`, which decides who
 * may see and change an Agent's app access and checks the scopes; the schemas only bound the
 * input's shape.
 */

/** The Apps tab's read, with times as ISO strings. */
export type AgentAppAccess = Omit<AgentAppAccessList, "grants" | "pendingRequests"> & {
  grants: (Omit<AgentAppAccessList["grants"][number], "grantedAt"> & { grantedAt: string })[];
  pendingRequests: (Omit<AgentAppAccessList["pendingRequests"][number], "createdAt"> & {
    createdAt: string;
  })[];
};

const actorOf = ({ user, workspaceId }: WorkspaceUserContext): AgentAppAccessActor => ({
  workspaceId,
  userId: user.id,
});

const agentInput = z.object({ agentId: agentIdSchema });

export const loadAgentAppAccess = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(agentInput)
  .handler(async ({ data, context }): Promise<AgentAppAccess> => {
    declareNoStore();
    const list = await createAppAgentAccess(context.db).list(actorOf(context), data.agentId);
    return {
      ...list,
      grants: list.grants.map((grant) => ({ ...grant, grantedAt: grant.grantedAt.toISOString() })),
      pendingRequests: list.pendingRequests.map((request) => ({
        ...request,
        createdAt: request.createdAt.toISOString(),
      })),
    };
  });

/** Grants an installed app to the Agent with the fixed scopes and `scopes`. */
export const grantAgentApp = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    agentInput.extend({
      appKey: z.string().max(APP_KEY_MAX_LENGTH),
      scopes: z.array(z.string().max(32)).max(APP_SCOPES.length),
    }),
  )
  .handler(async ({ data, context }) => {
    declareNoStore();
    await createAppAgentAccess(context.db).grant(actorOf(context), data);
  });

export const revokeAgentAppGrant = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(agentInput.extend({ grantId: z.uuid() }))
  .handler(async ({ data, context }) => {
    declareNoStore();
    await createAppAgentAccess(context.db).revoke(actorOf(context), data);
  });

/** Approves or denies the Agent's request for an app. */
export const decideAgentAppRequest = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(agentInput.extend({ requestId: z.uuid(), decision: z.enum(["approve", "deny"]) }))
  .handler(async ({ data: { decision, ...input }, context }) => {
    declareNoStore();
    const access = createAppAgentAccess(context.db);
    if (decision === "approve") await access.approve(actorOf(context), input);
    else await access.deny(actorOf(context), input);
  });
