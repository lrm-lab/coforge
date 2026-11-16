import type { PrismaClient } from "#src/generated/prisma/client";
import {
  systemEventDirectKey,
  type SystemEventSource,
} from "#src/server/app-agent-events/app-event-target.server";
import type { StoredAgentEvent } from "#src/server/app-agent-events/agent-events.server";
import type { SystemAgentEventStore } from "#src/server/app-agent-events/system-agent-events.server";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";
import { allocateSequence } from "#src/server/db/repositories/sequence-allocation.server";
import {
  eventConversation,
  eventMember,
} from "#src/server/db/repositories/agent-event-conversation.repositories.server";

export class PrismaSystemAgentEventStore implements SystemAgentEventStore {
  constructor(private readonly db: PrismaClient) {}

  async expiryAfter(ttlSeconds: number) {
    const [row] = await this.db.$queryRaw<{ expiresAt: Date }[]>`
      SELECT ((now() AT TIME ZONE 'UTC') + make_interval(secs => ${ttlSeconds}::double precision))::timestamp(3)
        AS "expiresAt"`;
    return row!.expiresAt;
  }

  async exists(source: SystemEventSource, agentId: string, externalEventId: string) {
    return (
      (await this.db.systemAgentEvent.findUnique({
        where: { source_agentId_externalEventId: { source, agentId, externalEventId } },
        select: { id: true },
      })) !== null
    );
  }

  async write(
    input: Parameters<SystemAgentEventStore["write"]>[0],
  ): Promise<StoredAgentEvent | undefined> {
    const conversationId = await eventConversation(
      this.db,
      input.workspaceId,
      systemEventDirectKey(input.source, input.agentId),
    );
    try {
      return await this.db.$transaction(async (tx) => {
        const agent = await tx.agent.findUniqueOrThrow({
          where: { id: input.agentId },
          select: { computerId: true, stoppedAt: true },
        });
        await eventMember(tx, conversationId, input.workspaceId, input.agentId);
        const sequence = await allocateSequence(tx, conversationId);
        const message = await tx.message.create({
          data: {
            workspaceId: input.workspaceId,
            conversationId,
            sequence,
            body: input.body,
            deliveries: {
              create: [
                {
                  workspaceId: input.workspaceId,
                  conversationId,
                  agentId: input.agentId,
                  sequence,
                  expiresAt: input.expiresAt,
                },
              ],
            },
          },
          include: { deliveries: true },
        });
        const event = await tx.systemAgentEvent.create({
          data: {
            source: input.source,
            agentId: input.agentId,
            workspaceId: input.workspaceId,
            conversationId,
            messageId: message.id,
            externalEventId: input.externalEventId,
            expiresAt: input.expiresAt,
          },
          select: { id: true },
        });
        return {
          eventId: event.id,
          conversationId,
          messageId: message.id,
          sequence,
          createdAtMs: message.createdAt.getTime(),
          deliveryId: message.deliveries[0]!.deliveryId,
          computerId: agent.stoppedAt ? null : agent.computerId,
        };
      });
    } catch (error) {
      if (isUniqueViolation(error)) return undefined;
      throw error;
    }
  }
}
