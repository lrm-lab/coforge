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
