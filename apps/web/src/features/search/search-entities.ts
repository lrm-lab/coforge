import type { GroupAvatarMember } from "#src/features/conversations/group-avatar";
import type { ChannelVisibility } from "#src/features/conversations/channel-visibility";
import { nameMatchTier } from "#src/lib/name-match";

/** A place or participant search can open directly: a channel, a Computer, an Agent, a member
 * (`id` is theirs; a search result), or the viewer's direct message with a member (`id` is the
 * conversation's; Frequently used only). */
export type SearchEntity =
  | {
      kind: "channel";
      id: string;
      name: string;
      description: string;
      archived: boolean;
      visibility: ChannelVisibility;
      /** Its group avatar, the row's face. */
      members?: readonly GroupAvatarMember[];
    }
  | { kind: "computer"; id: string; name: string; hostname: string; computerKind: string }
  | {
      kind: "agent";
      id: string;
      name: string;
      handle: string;
      avatarUrl: string | null;
      canMessage: boolean;
      /** The viewer's direct conversation with this Agent, once there is one. */
      dmId: string | null;
    }
  | {
      kind: "person";
      id: string;
      name: string;
      avatarUrl: string | null;
      /** The viewer's direct conversation with this member, once there is one. */
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

/** People and Agents first: who someone is looking for comes before where (Frank, task #95). */
const KIND_ORDER: Record<SearchEntity["kind"], number> = {
  person: 0,
  dm: 0,
  agent: 1,
  channel: 2,
  computer: 3,
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
    case "person":
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
 * The entities a query names, best first: closer name matches (`nameMatchTier`), then people,
 * Agents, channels and Computers in that order, then by name. A leading `#` keeps only channels
 * and a leading `@` only people and Agents, the way references are written in a message.
 */
export function matchSearchEntities(
  entities: readonly SearchEntity[],
  query: string,
): SearchEntity[] {
  const trimmed = query.trim();
  const only: readonly SearchEntity["kind"][] | undefined = trimmed.startsWith("#")
    ? ["channel"]
    : trimmed.startsWith("@")
      ? ["person", "dm", "agent"]
      : undefined;
  const lowerQuery = trimmed
    .replace(/^[#@]+/, "")
    .trim()
    .toLowerCase();
  if (!lowerQuery) return [];
  // Keep only the five best matches; equal ranks retain their original input order.
  const matches: SearchMatch[] = [];
  for (const entity of entities) {
    if (only && !only.includes(entity.kind)) continue;
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
