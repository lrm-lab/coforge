/**
 * The closed vocabulary of what a runtime reported for a launch's service tier. Leaf module (no
 * imports): the wire codec, the daemon, and the browser display parser all read one definition.
 * `unreported` is the catch-all — the runtime answered nothing this turn, which is not the same
 * as "off".
 */
export const AGENT_SERVICE_TIER_OBSERVED = {
  ON: "on",
  OFF: "off",
  COOLDOWN: "cooldown",
  UNREPORTED: "unreported",
} as const;

export type AgentServiceTierObserved =
  (typeof AGENT_SERVICE_TIER_OBSERVED)[keyof typeof AGENT_SERVICE_TIER_OBSERVED];
