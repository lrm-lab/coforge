import { cacheInvalidation } from "#src/server/cache-invalidation.server";

const CHANNEL = "coforge:channel-people:v1";

/**
 * Tells every process-local cache of a channel's visibility and people (the live Activity
 * audience, `agent-activity-audience`) that they changed, here and on every other web instance.
 * Call it after the write commits, never inside its transaction, so no instance re-reads the
 * old rows: a person joining, added to, leaving or removed from a channel, and any change of its
 * visibility (task #302).
 */
export function channelPeopleChanged(channelIds: Iterable<string>) {
  const signal = cacheInvalidation(CHANNEL);
  for (const channelId of channelIds) signal.notify(channelId);
}

/** Registers a cache's forget for `channelPeopleChanged`; a missing id flushes everything. */
export function forgetChannelPeopleWith(forget: (channelId?: string) => void) {
  cacheInvalidation(CHANNEL).forgetWith(forget);
}
