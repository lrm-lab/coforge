import type { PrismaClient } from "#src/generated/prisma/client";
import { getDatabaseClient } from "#src/server/db/client.server";
import { onServerShutdown } from "#src/server/runtime/server-lifecycle.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import {
  TARGET_CONVERSATION_SELECT,
  conversationTarget,
  deliveryTarget,
} from "#src/server/db/repositories/direct-conversation-agent-message.server";
import { directTargets } from "#src/server/db/repositories/agent-peer-direct.repositories.server";
import { AgentDeliveryPublisher } from "./agent-delivery.server";
import { publishActionCardUpdate } from "./action-card-message.server";
import { CentrifugoConversationRealtime } from "./conversation-realtime.server";

type ExpiredCard = {
  messageId: string;
  conversationId: string;
  workspaceId: string;
  preparedByAgentId: string;
  payload: unknown;
};

/**
 * Marks every pending card past its `expiresAt` as expired and tells the two sides, once.
 *
 * The `UPDATE … RETURNING` is the guard: two instances (a blue/green switch) run it together and
 * only the one whose statement changed the row gets it back, so a card is announced exactly once.
 * A card read before the sweep still reads as expired (`effectiveActionCardState`).
 */
export async function expireActionCards(db: PrismaClient, now: Date = new Date()): Promise<number> {
  const expired = await db.$queryRaw<ExpiredCard[]>`
    UPDATE "action_cards"
    SET "state" = 'expired', "updatedAt" = now()
    WHERE "state" = 'pending' AND "expiresAt" IS NOT NULL AND "expiresAt" <= ${now}
    RETURNING "messageId", "conversationId", "workspaceId", "preparedByAgentId", "payload"
  `;
  if (!expired.length) return 0;
  // A process without Centrifugo (a test, a maintenance run) still expires the rows.
  let realtime: CentrifugoConversationRealtime | undefined;
  let publisher: AgentDeliveryPublisher | undefined;
  try {
    realtime = new CentrifugoConversationRealtime(createCentrifugoServerApi());
    publisher = new AgentDeliveryPublisher(createCentrifugoServerApi());
  } catch {
    realtime = undefined;
    publisher = undefined;
  }
  for (const card of expired) {
    if (realtime)
      await publishActionCardUpdate(db, realtime, card.conversationId, card.messageId).catch(
        () => undefined,
      );
    await deliverExpired(db, publisher, card).catch(() => undefined);
  }
  return expired.length;
}

/** The Agent that asked learns its card expired; the asked person's Activity refreshed above. */
async function deliverExpired(
  db: PrismaClient,
  publisher: AgentDeliveryPublisher | undefined,
  card: ExpiredCard,
) {
  const [message, agent] = await Promise.all([
    db.message.findUnique({
      where: { id: card.messageId },
      select: {
        id: true,
        sequence: true,
        threadRootId: true,
        conversation: { select: TARGET_CONVERSATION_SELECT },
      },
    }),
    db.agent.findUnique({ where: { id: card.preparedByAgentId }, select: { computerId: true } }),
  ]);
  if (!message) return;
  const payload = card.payload as { prompt?: string } | null;
  const delivery = await db.agentMessageDelivery.create({
    data: {
      workspaceId: card.workspaceId,
      conversationId: card.conversationId,
      agentId: card.preparedByAgentId,
      messageId: card.messageId,
      sequence: message.sequence,
      reason: "expired",
    },
    select: { deliveryId: true, createdAt: true },
  });
  const targetOf = await directTargets(db, card.workspaceId, card.preparedByAgentId, [
    message.conversation,
  ]);
  const target = deliveryTarget(
    conversationTarget(message.conversation, targetOf),
    message.threadRootId,
  );
  if (!publisher) return;
  await publisher.publish(card.workspaceId, [
    {
      computerId: agent?.computerId ?? null,
      requestId: card.messageId,
      conversationId: card.conversationId,
      agentId: card.preparedByAgentId,
      messageId: card.messageId,
      deliveryId: delivery.deliveryId,
      sequence: message.sequence,
      createdAtMs: delivery.createdAt.getTime(),
      body: `Your action card "${payload?.prompt ?? "a card"}" expired in ${target}: nobody answered it.`,
      mentions: [],
      target,
      latestSenderKind: "system",
      latestSenderHandle: "",
      latestSenderDescription: "",
    },
  ]);
}

/** How often the sweep looks for expired cards; the state itself is exact. */
export const ACTION_CARD_EXPIRY_TICK_MS = 5 * 60 * 1_000;

/** Boot hook: a non-overlapping in-process tick, safe to run in every instance. */
export function startActionCardExpiryTick(deps: {
  db: () => PrismaClient | undefined;
  intervalMs?: number;
  setIntervalFn?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  log?: (event: Record<string, unknown>) => void;
}): { stop: () => void } {
  const setIntervalFn = deps.setIntervalFn ?? setInterval;
  const log = deps.log ?? ((event) => console.info(JSON.stringify(event)));
  let inFlight = false;
  const tick = () => {
    if (inFlight) return;
    inFlight = true;
    const db = deps.db();
    if (!db) {
      inFlight = false;
      return;
    }
    void expireActionCards(db)
      .then((count) => log({ event: "action_card_expiry_tick", expired: count }))
      .catch((error: unknown) =>
        log({
          event: "action_card_expiry_tick_failed",
          error: error instanceof Error ? error.name : typeof error,
        }),
      )
      .finally(() => {
        inFlight = false;
      });
  };
  const handle = setIntervalFn(tick, deps.intervalMs ?? ACTION_CARD_EXPIRY_TICK_MS);
  return { stop: () => clearInterval(handle) };
}

/** Boot hook: starts the sweep on the app's database client and stops it on shutdown. */
export function startActionCardExpiryTickFromEnv(): { stop: () => void } {
  const tick = startActionCardExpiryTick({ db: getDatabaseClient });
  onServerShutdown(tick.stop);
  return tick;
}
