/**
 * The pictures an Agent without its own upload shows, one chosen per Agent by its id. They ship
 * with the app (`public/agent-avatars/`), like the people's avatar presets, so nothing is copied
 * per Agent and nothing is stored: the same id picks the same picture on server and client. A
 * picture's file name is its identity: a new picture gets a new name, so a cached copy of the old
 * one is never shown in its place.
 */
const DEFAULT_AGENT_AVATAR_URLS = [
  "/agent-avatars/mascot-blue.svg",
  "/agent-avatars/mascot-orange.svg",
  "/agent-avatars/mascot-pink.svg",
  "/agent-avatars/mascot-green.svg",
  "/agent-avatars/mascot-purple.svg",
  "/agent-avatars/mascot-black.svg",
  "/agent-avatars/mascot-yellow.svg",
] as const;

/** The default picture of one Agent: a stable FNV-1a hash of its id, taken modulo the pool. */
export function defaultAgentAvatarUrl(agentId: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < agentId.length; index += 1) {
    hash = Math.imul(hash ^ agentId.charCodeAt(index), 0x01000193);
  }
  return DEFAULT_AGENT_AVATAR_URLS[(hash >>> 0) % DEFAULT_AGENT_AVATAR_URLS.length]!;
}
