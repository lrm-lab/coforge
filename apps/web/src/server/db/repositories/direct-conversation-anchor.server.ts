import {
  MESSAGE_ANCHOR_SOURCE,
  UUID_LIKE_SOURCE,
  type AgentMessageValidationMessage,
} from "@lrm/coforge-sdk/internal";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AgentMessageValidationError } from "#src/server/conversations/agent-message-validation-error.server";

/** The message-id short forms (eight hex, dashed twelve hex) or a full UUID; both address a
 * Message. */
export const MESSAGE_ANCHOR = new RegExp(`^(?:${MESSAGE_ANCHOR_SOURCE}|${UUID_LIKE_SOURCE})$`);

export function assertMessageAnchor(anchor: string) {
  if (!MESSAGE_ANCHOR.test(anchor))
    throw new AgentMessageValidationError(
      "message anchor must be eight hexadecimal characters or a full UUID",
    );
}

/** The single row an anchor lookup (`take: 2`) found; `notFound` is the miss message. */
export function onlyAnchorMatch<T>(rows: T[], notFound: AgentMessageValidationMessage): T {
  if (rows.length > 1)
    throw new AgentMessageValidationError("ambiguous message prefix; use the full UUID");
  const row = rows[0];
  if (!row) throw new AgentMessageValidationError(notFound);
  return row;
}

const MAX_SEQUENCE = 2 ** 31 - 1;

export type ReadAnchor = { sequence: number; threadRootId: string | null; bySequence?: true };

/**
 * Where a history read starts, ends or centers. A value of only decimal digits is a sequence
 * number (`--after 0` reads a conversation from its start), anything else addresses a Message.
 * The Message forms the CLI prints are never a bare eight characters (`msg=` is the full id, a
 * short one carries the dash after its eighth), so a printed anchor is never read as a sequence;
 * a bare eight-digit value typed by hand is one.
 */
export function isSequenceAnchor(anchor: string): boolean {
  return /^\d+$/.test(anchor);
}

export function sequenceAnchor(anchor: string, threadRootId: string | null): ReadAnchor {
  // `sequence` is a 32-bit column: past its largest value there is nothing newer, which is what
  // the clamp reads as.
  return {
    sequence: Math.min(Number(anchor), MAX_SEQUENCE),
    threadRootId,
    bySequence: true,
  };
}

/**
 * Whether `anchor` has messages on its older or newer side in `scope`. A Message anchor is itself
 * one of them; a sequence need not be, so the side is looked up.
 */
export async function anchorSideHasMessages(
  db: Pick<PrismaClient, "message">,
  scope: Prisma.MessageWhereInput,
  anchor: ReadAnchor | undefined,
  side: "older" | "newer",
): Promise<boolean> {
  if (!anchor) return false;
  if (!anchor.bySequence) return true;
  // Sequences start at 1: nothing lies at or below 0.
  if (side === "older" && anchor.sequence === 0) return false;
  const found = await db.message.findFirst({
    where: {
      ...scope,
      sequence: side === "older" ? { lte: anchor.sequence } : { gte: anchor.sequence },
    },
    select: { id: true },
  });
  return found !== null;
}
