import type { Prisma } from "#src/generated/prisma/client";

/** The message a person's send has just written, as a hook inside that send sees it. */
export type SentMessage = {
  id: string;
  conversationId: string;
  workspaceId: string;
  /** The stored body, its mentions and references already tokens. */
  body: string;
  senderMemberId: string;
  threadRootId: string | null;
};

/**
 * Work a caller adds to a send, inside the transaction that writes the message: what it writes
 * commits with the message or not at all, and a retried send (same idempotency key) replays the
 * stored message without running it again. Throwing refuses the send.
 */
export type SentMessageHook = (tx: Prisma.TransactionClient, message: SentMessage) => Promise<void>;
