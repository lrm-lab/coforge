import type { PrismaClient } from "#src/generated/prisma/client";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import {
  AgentDeliveryPublisher,
  type AgentDeliveryPush,
} from "#src/server/conversations/agent-delivery.server";
import { PrismaAgentEventStore } from "#src/server/db/repositories/app-agent-event.repositories.server";
import { PrismaAppAgentInboundStore } from "#src/server/db/repositories/app-agent-inbound.repositories.server";
import { isFeatureEnabled } from "#src/server/feature-flags/feature-flags.server";
import { AgentEvents } from "./agent-events.server";
import { AppAgentInbound } from "./app-agent-inbound.server";

const enabled = (workspace: { workspaceId: string; workspaceSlug: string }) =>
  isFeatureEnabled("app-agent-events", workspace);

/** Apps' access to send to Agents over PostgreSQL, behind `app-agent-events`. */
export function createAppAgentInbound(db: PrismaClient) {
  return new AppAgentInbound(new PrismaAppAgentInboundStore(db), enabled);
}

/** What pushes a committed event's delivery to the Agent's daemon; none: it is not pushed. */
export type AgentEventPush = () =>
  | ((workspaceId: string, push: AgentDeliveryPush) => Promise<void>)
  | undefined;

/** The push over Centrifugo; none when it is not configured, since the cloud read boundary repairs
 * a missed push. */
function centrifugoPush(): ReturnType<AgentEventPush> {
  try {
    const publisher = new AgentDeliveryPublisher(createCentrifugoServerApi());
    return async (workspaceId, push) => {
      await publisher.publish(workspaceId, [push]);
    };
  } catch {
    return undefined;
  }
}

/** Events apps send to Agents over PostgreSQL, delivered through `push` (default: Centrifugo). */
export function createAgentEvents(
  db: PrismaClient,
  {
    push = centrifugoPush,
  }: {
    push?: AgentEventPush;
  } = {},
) {
  return new AgentEvents(new PrismaAgentEventStore(db), async (workspaceId, delivery) => {
    await push()?.(workspaceId, delivery);
  });
}
