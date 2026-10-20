import { APP_GRANT_AGENT_CARD_KIND } from "@lrm/coforge-sdk/agent";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import {
  createActionCardMessage,
  publishActionCardMessage,
  publishActionCardUpdate,
} from "./action-card-message.server";
import {
  resolveActionCardTarget,
  type ActionCardTargetRepository,
} from "./action-card-target.server";
import type { ConversationRealtime } from "./conversation-realtime.server";

/** An Agent's request for an app that waits for a person's approval. */
export type WaitingAppRequest = {
  id: string;
  appKey: string;
  appName: string;
  scopes: string[];
};

/** The card for the request `requestId`, whatever its state. */
const requestCard = (workspaceId: string, requestId: string) => ({
  workspaceId,
  kind: APP_GRANT_AGENT_CARD_KIND,
  payload: { path: ["requestId"], equals: requestId },
});

/**
 * Settles, in the transaction that decides the request `requestId`, the card that asks for it:
 * `executed` by `userId` when approved, `cancelled` when denied. However the request was decided
 * (its card, the Agent's Apps tab, or a person's grant), the card never stays pending.
 */
export async function settleAppGrantCard(
  tx: Prisma.TransactionClient,
  requestId: string,
  decision: { approved: boolean; userId: string | null },
): Promise<void> {
  await tx.actionCard.updateMany({
    where: {
      kind: APP_GRANT_AGENT_CARD_KIND,
      state: "pending",
      payload: { path: ["requestId"], equals: requestId },
    },
    data: decision.approved
      ? {
          state: "executed",
          committedByUserId: decision.userId,
          committedAt: new Date(),
          result: { requestId },
        }
      : { state: "cancelled" },
  });
}

/**
 * The approval card an Agent's use of an app posts when a person must approve it
 * (`app:grant_agent`): at most one per request, wherever it was posted. A person commits it to
 * approve the request and cancels it to deny it (`ActionCards.commitAppGrant`/`denyAppGrant`).
 */
export class AppGrantCards {
  constructor(
    private readonly db: PrismaClient,
    private readonly conversations: ActionCardTargetRepository,
    private readonly realtime: () => ConversationRealtime | undefined,
  ) {}

  /** The card posted for the request `requestId`, if there is one. */
  async find(workspaceId: string, requestId: string): Promise<string | undefined> {
    const card = await this.db.actionCard.findFirst({
      where: requestCard(workspaceId, requestId),
      select: { messageId: true },
    });
    return card?.messageId;
  }

  /**
   * Posts the card for `request` to `target`, which the Agent must be able to post to (the
   * `message send` rules): its message id. A card already posted for the request is answered
   * instead, so asking again, or concurrently, never posts a second one; `undefined` when the
   * request no longer waits, since a person decided it meanwhile.
   */
  async post(
    agent: { workspaceId: string; agentId: string },
    target: string,
    request: WaitingAppRequest,
  ): Promise<string | undefined> {
    const resolved = await resolveActionCardTarget(
      this.db,
      this.conversations,
      agent.workspaceId,
      agent.agentId,
      target,
    );
    const posted = await this.db.$transaction(async (tx) => {
      // One posting per request at a time; the request row is what a second one, and a person
      // deciding the request, waits on.
      const waiting = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "app_agent_access_requests"
        WHERE "id" = ${request.id}::uuid AND "status" = 'pending' FOR UPDATE`;
      if (waiting.length === 0) return { messageId: undefined };
      const existing = await tx.actionCard.findFirst({
        where: requestCard(agent.workspaceId, request.id),
        select: { messageId: true },
      });
      if (existing) return { messageId: existing.messageId };
      const message = await createActionCardMessage(tx, agent, resolved, {
        kind: APP_GRANT_AGENT_CARD_KIND,
        payload: {
          type: APP_GRANT_AGENT_CARD_KIND,
          requestId: request.id,
          agentId: agent.agentId,
          appKey: request.appKey,
          appName: request.appName,
          scopes: request.scopes,
        },
        body: `Action card: approve my use of the app ${request.appName} (${request.appKey})`,
      });
      return { messageId: message.id, message };
    });
    if (posted.message)
      await publishActionCardMessage(
        this.db,
        this.realtime(),
        agent.workspaceId,
        resolved,
        posted.message,
      );
    return posted.messageId;
  }

  /** The request `requestId` was decided: browsers showing its card refresh it. */
  async publishDecided(workspaceId: string, requestId: string): Promise<void> {
    const card = await this.db.actionCard.findFirst({
      where: requestCard(workspaceId, requestId),
      select: { messageId: true, conversationId: true },
    });
    if (card)
      await publishActionCardUpdate(this.db, this.realtime(), card.conversationId, card.messageId);
  }
}
