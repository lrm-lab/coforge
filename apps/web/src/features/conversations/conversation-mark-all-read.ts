import type { QueryClient } from "@tanstack/react-query";

import { ACTIVITY_INBOX_QUERY_PREFIX } from "#src/features/inbox/activity-inbox-queries";
import { APP_ERROR_HTTP_STATUS, isAppError } from "#src/lib/app-error";
import { markPublicConversationAllRead } from "./channel-sidebar-actions.functions";
import { markOpenReadStale } from "./conversation-open-query";
import { markDirectConversationAllRead } from "./conversations.functions";
import type { PinRef } from "./pinned-conversations";
import { clearThreadUnreadMarksInConversationCaches } from "./thread-cache";
import {
  THREAD_UNREAD_BATCH_LIMIT,
  type ThreadUnreadBatch,
  type ThreadUnreadMark,
} from "./thread-unread-inputs";
import { loadConversationThreadUnreadSnapshot } from "./thread-unread.functions";

export type ThreadUnreadSnapshot = {
  throughSequence: number;
  marks: readonly ThreadUnreadMark[];
};

export function buildThreadUnreadBatches(
  snapshot: ThreadUnreadSnapshot,
  operationId: string = crypto.randomUUID(),
): ThreadUnreadBatch[] {
  if (snapshot.marks.length === 0) {
    return [{ operationId, throughSequence: snapshot.throughSequence, marks: [] }];
  }
  const batches: ThreadUnreadBatch[] = [];
  for (let offset = 0; offset < snapshot.marks.length; offset += THREAD_UNREAD_BATCH_LIMIT) {
    batches.push({
      operationId,
      throughSequence: snapshot.throughSequence,
      marks: snapshot.marks.slice(offset, offset + THREAD_UNREAD_BATCH_LIMIT),
    });
  }
  return batches;
}

export function isRetryableMarkAllReadError(error: unknown): boolean {
  if (isAppError(error)) {
    const status = APP_ERROR_HTTP_STATUS[error.code];
    return status >= 500 || status === 429;
  }
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && status >= 400 && status < 500) {
      return status === 408 || status === 429;
    }
  }
  return true;
}

export type MarkConversationAllReadPorts = {
  loadSnapshot: (conversationId: string) => Promise<ThreadUnreadSnapshot>;
  sendBatch: (target: PinRef, batch: ThreadUnreadBatch) => Promise<unknown>;
  wait?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  retryDelayMs?: (attempt: number) => number;
  operationId?: () => string;
  onBatchCleared?: (marks: readonly ThreadUnreadMark[]) => void;
};

const defaultPorts: MarkConversationAllReadPorts = {
  loadSnapshot: (conversationId) =>
    loadConversationThreadUnreadSnapshot({ data: { conversationId } }),
  sendBatch: (target, batch) =>
    target.kind === "channel"
      ? markPublicConversationAllRead({ data: { channelId: target.channelId, batch } })
      : markDirectConversationAllRead({ data: { conversationId: target.conversationId, batch } }),
};

const defaultWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function markConversationAllRead(
  target: PinRef,
  ports: MarkConversationAllReadPorts = defaultPorts,
): Promise<readonly ThreadUnreadMark[]> {
  const conversationId = target.kind === "channel" ? target.channelId : target.conversationId;
  const snapshot = await ports.loadSnapshot(conversationId);
  const operationId = (ports.operationId ?? (() => crypto.randomUUID()))();
  const batches = buildThreadUnreadBatches(snapshot, operationId);
  const maxAttempts = ports.maxAttempts ?? 3;
  const retryDelayMs = ports.retryDelayMs ?? ((attempt: number) => attempt * 300);
  const wait = ports.wait ?? defaultWait;
  for (const batch of batches) {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        await ports.sendBatch(target, batch);
        ports.onBatchCleared?.(batch.marks);
        break;
      } catch (error) {
        if (attempt >= maxAttempts || !isRetryableMarkAllReadError(error)) throw error;
        await wait(retryDelayMs(attempt));
      }
    }
  }
  return snapshot.marks;
}

export function afterConversationAllRead(
  queryClient: QueryClient,
  target: PinRef,
  cleared: unknown,
) {
  const conversationId = target.kind === "channel" ? target.channelId : target.conversationId;
  if (Array.isArray(cleared) && cleared.length > 0) {
    const marks = cleared as readonly ThreadUnreadMark[];
    clearThreadUnreadMarksInConversationCaches(queryClient, conversationId, marks);
    for (const mark of marks) markOpenReadStale(queryClient, conversationId, mark.rootMessageId);
  }
  markOpenReadStale(queryClient, conversationId);
  void queryClient.invalidateQueries({ queryKey: ACTIVITY_INBOX_QUERY_PREFIX });
}
