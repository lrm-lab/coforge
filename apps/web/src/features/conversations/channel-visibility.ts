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

/** Whether a channel is private. */
export function isPrivateChannel(channel: { visibility: ChannelVisibility }) {
  return channel.visibility === CHANNEL_VISIBILITY.PRIVATE;
}

/** A channel's name where only text fits (a placeholder, a toast, an accessible name): `#name`,
 * or the bare name for a private channel, whose lock never goes as `#`. */
export function channelLabel(channel: { name: string; visibility: ChannelVisibility }) {
  return isPrivateChannel(channel) ? channel.name : `#${channel.name}`;
}

/** Whether a request's value names a visibility. */
export function isChannelVisibility(value: unknown): value is ChannelVisibility {
  return value === CHANNEL_VISIBILITY.PUBLIC || value === CHANNEL_VISIBILITY.PRIVATE;
}
