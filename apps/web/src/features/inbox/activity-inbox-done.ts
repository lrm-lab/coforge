import { useCallback, useState } from "react";
import type { InfiniteData } from "@tanstack/react-query";

import {
  projectPendingActivityCompletions,
  type ActivityCompletionItem,
  type ActivityInboxPage,
} from "./activity-inbox-queries";

type PendingActivityDone = { item: ActivityCompletionItem; attempts: number };
export type ActivityDoneState = ReadonlyMap<string, PendingActivityDone>;

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

export type ActivityDoneCoordinatorOptions = {
  reconcileDelayMs?: number;
  onStart: (item: ActivityCompletionItem) => void;
  onSettle: (item: ActivityCompletionItem) => void;
  onMarkOtherListsStale: () => void;
  onReconcile: () => Promise<void>;
  onExternalRealtimeActivity: () => void;
};

export function createActivityDoneCoordinator({
  reconcileDelayMs = 350,
  onStart,
  onSettle,
  onMarkOtherListsStale,
  onReconcile,
  onExternalRealtimeActivity,
}: ActivityDoneCoordinatorOptions) {
  let inFlight = 0;
  let reconciling = false;
  let needsReconcile = false;
  let disposed = false;
  let reconcileTimer: ReturnType<typeof setTimeout> | undefined;
  const completedInBurst: ActivityCompletionItem[] = [];

  function clearTimer() {
    if (reconcileTimer !== undefined) {
      clearTimeout(reconcileTimer);
      reconcileTimer = undefined;
    }
  }

  function runReconcile() {
    clearTimer();
    if (disposed) return;
    if (reconciling) {
      needsReconcile = true;
      return;
    }
    reconciling = true;
    needsReconcile = false;
    const batch = completedInBurst.splice(0, completedInBurst.length);
    void Promise.resolve()
      .then(onReconcile)
      .catch(() => undefined)
      .finally(() => {
        reconciling = false;
        for (const entry of batch) onSettle(entry);
        if (disposed || inFlight > 0) return;
        if (needsReconcile) runReconcile();
        else if (completedInBurst.length > 0) scheduleReconcile();
      });
  }

  function scheduleReconcile() {
    clearTimer();
    if (disposed) return;
    reconcileTimer = setTimeout(() => {
      reconcileTimer = undefined;
      runReconcile();
    }, reconcileDelayMs);
  }

  return {
    enqueue(item: ActivityCompletionItem, write: () => Promise<unknown>, onFailed: () => void) {
      onStart(item);
      inFlight += 1;
      clearTimer();
      void Promise.resolve()
        .then(write)
        .then(
          () => {
            inFlight -= 1;
            completedInBurst.push(item);
            onMarkOtherListsStale();
            if (!disposed && inFlight === 0) scheduleReconcile();
          },
          () => {
            inFlight -= 1;
            onSettle(item);
            onFailed();
            if (!disposed) runReconcile();
          },
        );
    },
    onRealtimeActivity() {
      if (inFlight > 0 || reconcileTimer !== undefined || reconciling) return;
      onExternalRealtimeActivity();
    },
    dispose() {
      disposed = true;
      clearTimer();
    },
  };
}
