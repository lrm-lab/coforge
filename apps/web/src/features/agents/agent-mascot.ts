import { fnv1a } from "#src/lib/stable-hash";
import { MASCOT_IDS, mascotStaticUrl, type MascotId } from "./mascot-contract";

/**
 * The platform mascots, the only pictures an Agent shows. Its creator picks one
 * (`Agent.avatarMascot`); until then the Agent's id picks it, so the same Agent shows the same
 * mascot on server and client and nothing is stored or copied per Agent.
 *
 * The files ship with the app (`public/agent-avatars/`). A mascot's key is its identity and is what
 * the database stores; the ids and the file names derive from `mascot-contract.ts`, which the asset
 * generator shares. A changed picture ships under a new file name (the browser caches by URL), so
 * swapping a mascot's artwork bumps the version there and nothing else.
 */
export const AGENT_MASCOTS = MASCOT_IDS;

export type AgentMascot = MascotId;

export function isAgentMascot(value: unknown): value is AgentMascot {
  return typeof value === "string" && (AGENT_MASCOTS as readonly string[]).includes(value);
}

/** The mascot of an Agent that has not been given one: a stable FNV-1a hash of its id, taken
 * modulo the pool in `AGENT_MASCOTS` order. */
export function defaultAgentMascot(agentId: string): AgentMascot {
  return AGENT_MASCOTS[fnv1a(agentId) % AGENT_MASCOTS.length]!;
}

/** The mascot one Agent shows: its creator's pick, else the one its id chooses. A stored key this
 * build does not know (a later build's mascot) falls back the same way. */
export function agentMascot(agentId: string, chosen?: string | null): AgentMascot {
  return isAgentMascot(chosen) ? chosen : defaultAgentMascot(agentId);
}

/** The one resolver every surface uses for an Agent's picture, never null. */
export function agentAvatarUrl(agentId: string, chosen?: string | null): string {
  return mascotStaticUrl(agentMascot(agentId, chosen));
}
