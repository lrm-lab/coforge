import { z } from "zod";

/**
 * Who may read a channel (`Conversation.visibility`). `"public"`: every Workspace member, as every
 * channel always was. `"private"`: only its active members, people and Agents; a Workspace owner or
 * admin who has not joined it cannot see it either. A direct or internal conversation is always
 * `"public"` here: its own membership already decides who reads it.
 */
export const CHANNEL_VISIBILITY = {
  PUBLIC: "public",
  PRIVATE: "private",
} as const;
export type ChannelVisibility = (typeof CHANNEL_VISIBILITY)[keyof typeof CHANNEL_VISIBILITY];

/** A stored `Conversation.visibility` as its type. The column's CHECK allows only the two; anything
 * else would read as the narrower `"private"`. */
export function channelVisibilityOf(channel: { visibility: string }): ChannelVisibility {
  return channel.visibility === CHANNEL_VISIBILITY.PUBLIC
    ? CHANNEL_VISIBILITY.PUBLIC
    : CHANNEL_VISIBILITY.PRIVATE;
}

/** A visibility as a request or an event carries it. */
export const channelVisibilitySchema = z.enum([
  CHANNEL_VISIBILITY.PUBLIC,
  CHANNEL_VISIBILITY.PRIVATE,
]);

/** Whether a channel is private; absent (a row read before private channels) is public. */
export function isPrivateChannel(channel: { visibility?: ChannelVisibility }) {
  return channel.visibility === CHANNEL_VISIBILITY.PRIVATE;
}

/** Whether a request's value names a visibility. */
export function isChannelVisibility(value: unknown): value is ChannelVisibility {
  return value === CHANNEL_VISIBILITY.PUBLIC || value === CHANNEL_VISIBILITY.PRIVATE;
}

/** A channel's visibility as a page or list row carries it: optional, so a row kept in the
 * browser's storage from before private channels still opens, as public (`STORED_SHAPE_VERSION`). */
export function visibilityField(channel: { visibility: string }): {
  visibility?: ChannelVisibility;
} {
  return { visibility: channelVisibilityOf(channel) };
}
