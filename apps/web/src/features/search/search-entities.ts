import { nameMatchTier } from "#src/lib/name-match";

/** A place or participant the search page can open directly: a channel, a Computer, an Agent, or
 * the viewer's direct message with a member (`id` is the conversation's; Frequently used only). */
export type SearchEntity =
  | { kind: "channel"; id: string; name: string; description: string; archived: boolean }
  | { kind: "computer"; id: string; name: string; hostname: string; computerKind: string }
  | {
      kind: "agent";
      id: string;
      name: string;
      handle: string;
      avatarUrl: string | null;
      ownedByCurrentUser: boolean;
      /** The viewer's direct conversation with this Agent, once there is one. */
      dmId: string | null;
    }
  | {
      kind: "dm";
      id: string;
      peerId: string;
      name: string;
      avatarUrl: string | null;
    };

/** Most matches listed above the messages. */
const SEARCH_ENTITY_LIMIT = 5;

const KIND_ORDER: Record<SearchEntity["kind"], number> = {
  channel: 0,
  computer: 1,
  agent: 2,
  dm: 3,
};

/** A description match ranks below every name match. */
const DESCRIPTION_TIER = 4;

function matchTier(entity: SearchEntity, lowerQuery: string): number | undefined {
  switch (entity.kind) {
    case "channel":
      return (
        nameMatchTier(entity.name, [], lowerQuery) ??
        (entity.description.toLowerCase().includes(lowerQuery) ? DESCRIPTION_TIER : undefined)
      );
    case "computer":
      return nameMatchTier(entity.name, [entity.hostname], lowerQuery);
    case "agent":
      return nameMatchTier(entity.name, [entity.handle], lowerQuery);
    case "dm":
      return nameMatchTier(entity.name, [], lowerQuery);
  }
}

type SearchMatch = { entity: SearchEntity; tier: number };

function compareSearchMatches(left: SearchMatch, right: SearchMatch): number {
  return (
    left.tier - right.tier ||
    KIND_ORDER[left.entity.kind] - KIND_ORDER[right.entity.kind] ||
    left.entity.name.localeCompare(right.entity.name)
  );
}

/**
 * The entities a query names, best first: closer name matches (`nameMatchTier`), then channels,
 * Computers and Agents in that order, then by name. A leading `#` keeps only channels and a
 * leading `@` only Agents, the way references are written in a message.
 */
export function matchSearchEntities(
  entities: readonly SearchEntity[],
  query: string,
): SearchEntity[] {
  const trimmed = query.trim();
  const only = trimmed.startsWith("#") ? "channel" : trimmed.startsWith("@") ? "agent" : undefined;
  const lowerQuery = trimmed
    .replace(/^[#@]+/, "")
    .trim()
    .toLowerCase();
  if (!lowerQuery) return [];
  // Keep only the five best matches; equal ranks retain their original input order.
  const matches: SearchMatch[] = [];
  for (const entity of entities) {
    if (only && entity.kind !== only) continue;
    const tier = matchTier(entity, lowerQuery);
    if (tier === undefined) continue;
    const match = { entity, tier };
    const last = matches[SEARCH_ENTITY_LIMIT - 1];
    if (last && compareSearchMatches(match, last) >= 0) continue;
    const index = matches.findIndex((current) => compareSearchMatches(match, current) < 0);
    matches.splice(index < 0 ? matches.length : index, 0, match);
    if (matches.length > SEARCH_ENTITY_LIMIT) matches.pop();
  }
  return matches.map(({ entity }) => entity);
}
