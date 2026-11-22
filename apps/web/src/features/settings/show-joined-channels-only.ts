import { createDevicePreference } from "./device-preference";

const JOINED_ONLY = "joined";
const ALL_CHANNELS = "all";

const preference = createDevicePreference<boolean>({
  key: "coforge-chat-joined-channels-only",
  parse: (stored) => stored === JOINED_ONLY,
  serialize: (joinedOnly) => (joinedOnly ? JOINED_ONLY : ALL_CHANNELS),
  fallback: false,
});

export const readShowJoinedChannelsOnly = preference.read;
export const writeShowJoinedChannelsOnly = preference.write;
export const useShowJoinedChannelsOnly = preference.useValue;
