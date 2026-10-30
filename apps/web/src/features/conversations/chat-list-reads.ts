/** The Chat page's list reads that `loadChatLists` answers together, in one call. */
export const CHAT_LIST_READS = [
  "channels",
  "channelNames",
  "saved",
  "directPreferences",
  "directBadges",
  "sections",
  "sectionOrder",
] as const;

export type ChatListRead = (typeof CHAT_LIST_READS)[number];
