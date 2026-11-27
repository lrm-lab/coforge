import { z } from "zod";

export function messageIdFromHash(hash: string): string | undefined {
  if (!hash.startsWith("#message-")) return;
  const messageId = hash.slice("#message-".length);
  return messageId || undefined;
}

export function threadRootFromMessageAnchor(
  messages: ReadonlyArray<{ id: string; threadRootId?: string }>,
  hash: string,
): string | undefined {
  const messageId = messageIdFromHash(hash);
  if (!messageId) return;
  const message = messages.find((candidate) => candidate.id === messageId);
  return message?.threadRootId ?? message?.id;
}

export function resolveConversationThreadRoot(input: {
  searchThreadRootId: string | undefined;
  messages: ReadonlyArray<{ id: string; threadRootId?: string }>;
}): string | undefined {
  if (!input.searchThreadRootId) return;
  const message = input.messages.find((candidate) => candidate.id === input.searchThreadRootId);
  return message?.threadRootId ?? message?.id ?? input.searchThreadRootId;
}

export function conversationSearchWithThread<T extends object>(
  previous: T,
  threadRootId: string,
): T & { threadRootId: string } {
  return { ...previous, threadRootId };
}

export function conversationSearchWithoutThread<T extends { threadRootId?: string }>(
  previous: T,
): Omit<T, "threadRootId"> {
  const { threadRootId: _threadRootId, ...rest } = previous;
  return rest;
}

export const openTaskParamSchema = z.coerce.number().int().positive().optional().catch(undefined);

export function conversationSearchWithTask<T extends object>(
  previous: T,
  task: number,
): T & { task: number } {
  return { ...previous, task };
}

export function conversationSearchWithoutTask<T extends { task?: unknown }>(
  previous: T,
): Omit<T, "task"> {
  const { task: _task, ...rest } = previous;
  return rest;
}

export function conversationSearchForThread<
  T extends {
    details?: unknown;
    doc?: string;
    docFull?: boolean;
  },
>(previous: T): Omit<T, "details" | "doc" | "docFull"> {
  const { details: _details, doc: _doc, docFull: _docFull, ...rest } = previous;
  return rest;
}

export type PositionJumpDecision =
  | { action: "idle" }
  | { action: "ignore" }
  | { action: "show"; id: string }
  | { action: "consume"; id: string };

export function positionJumpDecision(
  jumpMessage: string | undefined,
  hash: string,
  consumed: string | undefined,
): PositionJumpDecision {
  if (!jumpMessage) return { action: "idle" };
  if (consumed === jumpMessage) return { action: "ignore" };
  return hash ? { action: "consume", id: jumpMessage } : { action: "show", id: jumpMessage };
}

export function hostedLandingAfterConsume(threadAlone: boolean): "keep" | "clear" {
  return threadAlone ? "keep" : "clear";
}

export function newerPageCommit(
  startedFollowing: boolean,
  stillFollowing: boolean,
): "pin-bottom" | "keep-anchor" {
  return startedFollowing && stillFollowing ? "pin-bottom" : "keep-anchor";
}
