import { useEffect, useRef, useState } from "react";

import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";
import { DURATION_MS } from "#src/utils/motion-tokens";

export const ITEM_LEAVE_MS = DURATION_MS.mdOut;
export const MAX_ANIMATED_LEAVES = 3;

export type LeavingEntry<T> = {
  readonly key: string;
  readonly item: T;
  readonly index: number;
};

export type LeavingRow<T> = {
  readonly item: T;
  readonly leaving: boolean;
};

export function reconcileLeavingItems<T>(
  previous: readonly T[],
  next: readonly T[],
  activeLeaving: readonly LeavingEntry<T>[],
  getKey: (item: T) => string,
): {
  leaving: readonly LeavingEntry<T>[];
  addedKeys: readonly string[];
} {
  const nextKeys = new Set(next.map(getKey));
  const filteredLeaving = activeLeaving.filter((entry) => !nextKeys.has(entry.key));
  const stillLeaving =
    filteredLeaving.length === activeLeaving.length ? activeLeaving : filteredLeaving;
  const gone: LeavingEntry<T>[] = [];
  for (let index = 0; index < previous.length; index++) {
    const item = previous[index]!;
    const key = getKey(item);
    if (!nextKeys.has(key)) gone.push({ key, item, index });
  }
  if (gone.length === 0) return { leaving: stillLeaving, addedKeys: [] };
  if (gone.length > MAX_ANIMATED_LEAVES) {
    return { leaving: activeLeaving.length === 0 ? activeLeaving : [], addedKeys: [] };
  }
  const existingKeys = new Set(stillLeaving.map((entry) => entry.key));
  const added = gone.filter((entry) => !existingKeys.has(entry.key));
  if (added.length === 0) return { leaving: stillLeaving, addedKeys: [] };
  return {
    leaving: [...stillLeaving, ...added],
    addedKeys: added.map((entry) => entry.key),
  };
}

export function mergeLeavingItems<T>(
  items: readonly T[],
  leaving: readonly LeavingEntry<T>[],
  getKey: (item: T) => string,
): readonly LeavingRow<T>[] {
  const activeKeys = new Set(items.map(getKey));
  const rows: LeavingRow<T>[] = items.map((item) => ({ item, leaving: false }));
  for (const entry of leaving) {
    if (activeKeys.has(entry.key)) continue;
    rows.splice(Math.min(entry.index, rows.length), 0, { item: entry.item, leaving: true });
  }
  return rows;
}

function defaultGetKey(item: { id: string }): string {
  return item.id;
}

export function useLeavingItems<T extends { id: string }>(
  items: readonly T[],
  options?: { getKey?: (item: T) => string; resetKey?: unknown },
): readonly LeavingRow<T>[];
export function useLeavingItems<T>(
  items: readonly T[],
  options: { getKey: (item: T) => string; resetKey?: unknown },
): readonly LeavingRow<T>[];
export function useLeavingItems<T>(
  items: readonly T[],
  options?: { getKey?: (item: T) => string; resetKey?: unknown },
): readonly LeavingRow<T>[] {
  const getKey = (options?.getKey ?? defaultGetKey) as (item: T) => string;
  const resetKey = options?.resetKey;
  const reduceMotion = usePrefersReducedMotion();
  const [leaving, setLeaving] = useState<readonly LeavingEntry<T>[]>([]);
  const previousRef = useRef(items);
  const resetKeyRef = useRef(resetKey);
  const leavingRef = useRef(leaving);
  const getKeyRef = useRef(getKey);
  const timersRef = useRef<Set<number>>(new Set());

  leavingRef.current = leaving;
  getKeyRef.current = getKey;

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);

  useEffect(() => {
    const resetChanged = !Object.is(resetKeyRef.current, resetKey);
    resetKeyRef.current = resetKey;
    if (resetChanged || reduceMotion) {
      previousRef.current = items;
      for (const timer of timersRef.current) window.clearTimeout(timer);
      timersRef.current.clear();
      if (leavingRef.current.length > 0) setLeaving([]);
      return;
    }

    const result = reconcileLeavingItems(
      previousRef.current,
      items,
      leavingRef.current,
      getKeyRef.current,
    );
    previousRef.current = items;
    if (result.leaving !== leavingRef.current) {
      setLeaving(result.leaving);
    }
    if (result.addedKeys.length === 0) return;

    const expired = new Set(result.addedKeys);
    const timer = window.setTimeout(() => {
      timersRef.current.delete(timer);
      setLeaving((current) => current.filter((entry) => !expired.has(entry.key)));
    }, ITEM_LEAVE_MS);
    timersRef.current.add(timer);
  }, [items, reduceMotion, resetKey]);

  return mergeLeavingItems(items, leaving, getKey);
}
