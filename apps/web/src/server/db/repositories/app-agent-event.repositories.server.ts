import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import {
  APP_EVENTS_KIND,
  appEventDirectKey,
} from "#src/server/app-agent-events/app-event-target.server";
import type {
  AgentEventStore,
  StoredAgentEvent,
} from "#src/server/app-agent-events/agent-events.server";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";
import { allocateSequence } from "#src/server/db/repositories/sequence-allocation.server";

/** Event rows and the dedicated conversation they land in; what an event may say and who may send it
 * stay in `server/app-agent-events/`. */
export class PrismaAgentEventStore implements AgentEventStore {
  constructor(private readonly db: PrismaClient) {}

  async expiryAfter(ttlSeconds: number) {
    const [row] = await this.db.$queryRaw<{ expiresAt: Date }[]>`
      SELECT ((now() AT TIME ZONE 'UTC') + make_interval(secs => ${ttlSeconds}::double precision))::timestamp(3)
        AS "expiresAt"`;
    return row!.expiresAt;
  }

  async find(appId: string, agentId: string, externalEventId: string) {
    const row = await this.db.appAgentEvent.findUnique({
      where: { appId_agentId_externalEventId: { appId, agentId, externalEventId } },
      select: { id: true },
    });
    return row?.id;
  }

  async write(
    input: Parameters<AgentEventStore["write"]>[0],
  ): Promise<StoredAgentEvent | undefined> {
    const conversationId = await this.conversation(input.app.id, input.workspaceId, input.agentId);
    try {
      return await this.db.$transaction(async (tx) => {
        const agent = await tx.agent.findUniqueOrThrow({
          where: { id: input.agentId },
          select: { computerId: true, stoppedAt: true },
        });
        await this.member(tx, conversationId, input.workspaceId, input.agentId);
        const sequence = await allocateSequence(tx, conversationId);
        const message = await tx.message.create({
          data: {
            workspaceId: input.workspaceId,
            conversationId,
            sequence,
            body: input.body,
            // A stale event's delivery is never pushed, replayed or counted (`liveDeliverySql`).
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
        const event = await tx.appAgentEvent.create({
          data: {
            appId: input.app.id,
            agentId: input.agentId,
            workspaceId: input.workspaceId,
            conversationId,
            messageId: message.id,
            kind: input.kind,
            summary: input.summary,
            payload: input.payload as Prisma.InputJsonObject,
            payloadHash: input.payloadHash,
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
      // A retry with the same external id won the race: the caller reads the original.
      if (isUniqueViolation(error) && input.externalEventId) return undefined;
      throw error;
    }
  }

  /** The dedicated conversation, made by the first event; two first events racing share one. */
  private async conversation(appId: string, workspaceId: string, agentId: string) {
    const directKey = appEventDirectKey(appId, agentId);
    const where = { workspaceId_directKey: { workspaceId, directKey } };
    const found = await this.db.conversation.findUnique({ where, select: { id: true } });
    if (found) return found.id;
    try {
      return (
        await this.db.conversation.create({
          data: { workspaceId, directKey, kind: APP_EVENTS_KIND },
          select: { id: true },
        })
      ).id;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return (await this.db.conversation.findUniqueOrThrow({ where, select: { id: true } })).id;
    }
  }

  /** The Agent is the conversation's one member; a member who left comes back. */
  private member(
    tx: Prisma.TransactionClient,
    conversationId: string,
    workspaceId: string,
    agentId: string,
  ) {
    return tx.conversationMember.upsert({
      where: { conversationId_agentId: { conversationId, agentId } },
      create: { conversationId, workspaceId, agentId },
      update: { leftAt: null },
      select: { id: true },
    });
  }
}
