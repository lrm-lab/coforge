import { useCallback, useState } from "react";
import type { InfiniteData } from "@tanstack/react-query";

import {
  projectPendingActivityCompletions,
  type ActivityCompletionItem,
  type ActivityInboxPage,
} from "./activity-inbox-queries";

type PendingActivityDone = { item: ActivityCompletionItem; attempts: number };
export type ActivityDoneState = ReadonlyMap<string, PendingActivityDone>;

/** Starts one attempt without letting an older attempt for the same row own its projection. */
export function startActivityDone(
  current: ActivityDoneState,
  item: ActivityCompletionItem,
): ActivityDoneState {
  const previous = current.get(item.key);
  return new Map(current).set(item.key, {
    item,
    attempts: (previous?.attempts ?? 0) + 1,
  });
}

/** Settles only its own attempt; a retry of the same row stays projected. */
export function settleActivityDone(
  current: ActivityDoneState,
  item: ActivityCompletionItem,
): ActivityDoneState {
  const previous = current.get(item.key);
  if (!previous) return current;
  const next = new Map(current);
  if (previous.attempts === 1) next.delete(item.key);
  else next.set(item.key, { ...previous, attempts: previous.attempts - 1 });
  return next;
}

export function pendingActivityDoneItems(current: ActivityDoneState): ActivityCompletionItem[] {
  return [...current.values()].map((entry) => entry.item);
}

/** Keeps every in-flight Done projected out until its write and canonical refresh settle. */
export function useActivityDoneProjection() {
  const [pending, setPending] = useState<ActivityDoneState>(() => new Map());
  const start = useCallback((item: ActivityCompletionItem) => {
    setPending((current) => startActivityDone(current, item));
  }, []);
  const settle = useCallback((item: ActivityCompletionItem) => {
    setPending((current) => settleActivityDone(current, item));
  }, []);
  const project = useCallback(
    (data: InfiniteData<ActivityInboxPage>) =>
      projectPendingActivityCompletions(data, pendingActivityDoneItems(pending)),
    [pending],
  );
  return { start, settle, project };
}
