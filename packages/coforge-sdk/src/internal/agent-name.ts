/**
 * The Agent name — the public `@handle` fixed at creation and never renamed afterward:
 * lowercase alphanumerics in single-hyphen-separated segments, at most 64 characters.
 *
 * The one definition, because more than one side has to agree on it and the SDK cannot import the
 * Web app: the create/edit form schema (`apps/web/src/features/agents/agent.schemas.ts`), the
 * deletion path that builds a freed name from the bound (`agent.repositories.server.ts`), and the
 * longest public handle a message can carry as its sender (`./message-sender.ts`).
 */
export const AGENT_NAME_MAX_LENGTH = 64;

/** The Agent-name grammar: at least one lowercase alphanumeric run, further runs after single
 * hyphens. */
export const AGENT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** `name` with `suffix` after it, the name cut (never the suffix) so the whole is still a valid
 * name: at most `AGENT_NAME_MAX_LENGTH`, with no hyphen left before the suffix's own. */
export function suffixedAgentName(name: string, suffix: string): string {
  return `${name.slice(0, AGENT_NAME_MAX_LENGTH - suffix.length).replace(/-+$/, "")}${suffix}`;
}

/** `name`, or the first of `name-2`, `name-3`… not in `taken` (lowercase handles): the name a
 * form suggests when the one it would suggest is already an Agent's. */
export function freeAgentName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = suffixedAgentName(name, `-${suffix}`);
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * The name a deleted Agent gives up its username for. It stays a valid name, because the deleted
 * Agent's messages still reach readers with it as their sender handle, and a handle outside the
 * grammar fails the sender check on every history read. The 12 hex digits of the id keep renamed
 * rows of the same name apart.
 */
export function deletedAgentName(name: string, agentId: string): string {
  return suffixedAgentName(name, `-deleted-${agentId.replaceAll("-", "").slice(0, 12)}`);
}
