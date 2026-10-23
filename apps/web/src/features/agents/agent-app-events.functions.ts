import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import {
  workspaceUserMiddleware,
  type WorkspaceUserContext,
} from "#src/features/auth/function-auth";
import { declareNoStore } from "#src/features/no-store-response.server";
import { createAppAgentInbound } from "#src/server/app-agent-events/app-agent-events-composition.server";
import type {
  AgentInboundList,
  InboundActor,
} from "#src/server/app-agent-events/app-agent-inbound.server";
import { agentIdSchema } from "./agent.schemas";

/**
 * The Agent profile's App events section (Agent inbound): which apps may send events to the
 * Agent, the requests waiting for a person, and the events they sent. Thin wrappers over
 * `server/app-agent-events/`, which decides who may see and change them.
 */

/** The section's read, with times as ISO strings. */
export type AgentAppEvents = Omit<AgentInboundList, "grants" | "pendingRequests" | "events"> & {
  grants: (Omit<AgentInboundList["grants"][number], "grantedAt"> & { grantedAt: string })[];
  pendingRequests: (Omit<AgentInboundList["pendingRequests"][number], "createdAt"> & {
    createdAt: string;
  })[];
  events: (Omit<AgentInboundList["events"][number], "createdAt" | "expiresAt" | "payload"> & {
    createdAt: string;
    expiresAt: string;
    /** The payload as pretty-printed JSON text; none for someone who may not manage the Agent's app access. */
    payloadText: string | null;
  })[];
};

const actorOf = ({ user, workspaceId }: WorkspaceUserContext): InboundActor => ({
  workspaceId,
  userId: user.id,
});

const agentInput = z.object({ agentId: agentIdSchema });

export const loadAgentAppEvents = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(agentInput)
  .handler(async ({ data, context }): Promise<AgentAppEvents> => {
    declareNoStore();
    const list = await createAppAgentInbound(context.db).list(actorOf(context), data.agentId);
    return {
      ...list,
      grants: list.grants.map((grant) => ({ ...grant, grantedAt: grant.grantedAt.toISOString() })),
      pendingRequests: list.pendingRequests.map((request) => ({
        ...request,
        createdAt: request.createdAt.toISOString(),
      })),
      events: list.events.map(({ payload, ...event }) => ({
        ...event,
        payloadText: payload === null ? null : JSON.stringify(payload, null, 2),
        createdAt: event.createdAt.toISOString(),
        expiresAt: event.expiresAt.toISOString(),
      })),
    };
  });

/** Approves or denies an app's request to send to the Agent. */
export const decideAgentAppEventRequest = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(agentInput.extend({ requestId: z.uuid(), decision: z.enum(["approve", "deny"]) }))
  .handler(async ({ data: { decision, ...input }, context }) => {
    declareNoStore();
    const inbound = createAppAgentInbound(context.db);
    if (decision === "approve") await inbound.approve(actorOf(context), input);
    else await inbound.deny(actorOf(context), input);
  });

/** Revokes an app's grant to send to the Agent. */
export const revokeAgentAppEventGrant = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(agentInput.extend({ grantId: z.uuid() }))
  .handler(async ({ data, context }) => {
    declareNoStore();
    await createAppAgentInbound(context.db).revoke(actorOf(context), data);
  });
