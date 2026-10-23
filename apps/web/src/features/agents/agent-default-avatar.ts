/**
 * The picture every Agent without its own upload shows, the CoForge mascot. It ships with the app
 * (`public/agent-avatars/`), like the people's avatar presets, so nothing is copied per Agent and
 * changing it changes every such Agent at once. Its file name carries its version: a new picture
 * gets a new name, so a cached copy of the old one is never shown in its place.
 */
export const DEFAULT_AGENT_AVATAR_URL = "/agent-avatars/mascot-01.webp";
