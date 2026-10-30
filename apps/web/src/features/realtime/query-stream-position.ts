import type { QueryClient, QueryKey } from "@tanstack/react-query";

import {
  missedBySubscribe,
  type StreamPosition,
  type StreamPositions,
  type SubscribedRecovery,
} from "./subscription-gap";

/** How long a subscribe waits for a read under way before it goes on as if the read had no
 * position (and the page reads again). */
const READ_SETTLE_TIMEOUT_MS = 10_000;

/** Resolves true once no read of `queryKey` is under way, false if one still is after
 * `READ_SETTLE_TIMEOUT_MS`. */
function readSettled(queryClient: QueryClient, queryKey: QueryKey): Promise<boolean> {
  const reading = () => queryClient.isFetching({ queryKey }) > 0;
  if (!reading()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const settle = (settled: boolean) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(settled);
    };
    const timer = setTimeout(() => settle(false), READ_SETTLE_TIMEOUT_MS);
    const unsubscribe = queryClient.getQueryCache().subscribe(() => {
      if (!reading()) settle(true);
    });
  });
}

/**
 * Where a Query's last server read stands in `channel`'s stream (`readAfterStreamPositions`), its
 * data's `streamPositions` unless `positionsOf` says where they are. A read under way settles
 * first, so a subscribe that lands during the page's own read is judged by that read instead of
 * re-reading over it. Undefined when the read had no position for the channel, or is still under
 * way after `READ_SETTLE_TIMEOUT_MS`.
 */
export async function queryStreamPosition<Data>(
  queryClient: QueryClient,
  queryKey: QueryKey,
  channel: string,
  positionsOf: (data: Data | undefined) => StreamPositions | undefined = (data) =>
    (data as { streamPositions?: StreamPositions } | undefined)?.streamPositions,
): Promise<StreamPosition | undefined> {
  if (!(await readSettled(queryClient, queryKey))) return undefined;
  return positionsOf(queryClient.getQueryData<Data>(queryKey))?.[channel];
}

/** Re-reads a Query that `channel` keeps live if its subscribe may have missed something
 * (`missedBySubscribe`), judged by where the Query was read (`queryStreamPosition`). */
export async function rereadQueryMissedBySubscribe<Data>(
  queryClient: QueryClient,
  queryKey: QueryKey,
  channel: string,
  recovery: SubscribedRecovery,
  reread: () => unknown,
  positionsOf?: (data: Data | undefined) => StreamPositions | undefined,
): Promise<void> {
  const missed = await missedBySubscribe(recovery, () =>
    queryStreamPosition(queryClient, queryKey, channel, positionsOf),
  );
  if (missed) reread();
}
