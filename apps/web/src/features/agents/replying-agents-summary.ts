import { agentMascot, type AgentMascot } from "./agent-mascot";
import type { LiveAgent } from "./workspace-agents-realtime";

/** The most mascots drawn side by side; the sentence still names everyone. */
export const MAX_REPLYING_FACES = 3;
/** The most names a sentence spells out; a longer list shows two and counts the rest. */
const MAX_NAMES_SPELLED = 3;
const NAMES_BEFORE_OTHERS = 2;

export type ReplyingAgent = {
  id: string;
  name: string;
  /** The Agent's mascot: its creator's pick, else the one its id chooses. */
  mascot: AgentMascot;
};

/**
 * The replying Agents the live roster knows, in the order given (the order they started), by
 * display name. An Agent outside the roster (a private Agent the viewer cannot see) is left out:
 * there is no name to show.
 */
export function replyingAgentsAmong(
  roster: readonly Pick<LiveAgent, "id" | "name" | "displayName" | "mascot">[],
  agentIds: readonly string[],
): ReplyingAgent[] {
  const byId = new Map(roster.map((agent) => [agent.id, agent]));
  return agentIds.flatMap((id) => {
    const agent = byId.get(id);
    return agent
      ? [
          {
            id,
            name: agent.displayName.trim() || agent.name,
            mascot: agentMascot(agent.id, agent.mascot),
          },
        ]
      : [];
  });
}

/** The sentence's names: a list of up to three, or the first two and how many there are in all. */
export type ReplyingNames =
  | { kind: "list"; text: string; plural: boolean }
  | { kind: "overflow"; first: string; second: string; rest: number; total: number };

/**
 * The names as a list for up to three Agents, as Raft writes it: "Atlas, Ben and Cam" (no serial
 * comma) and "Atlas，Ben，Cam". More than three name the first two and count the others; how that
 * reads is the message's ("Atlas, Ben and 2 other agents", "Atlas，Ben 等 4 个智能体").
 */
export function replyingNames(names: readonly string[], locale: string): ReplyingNames {
  if (names.length > MAX_NAMES_SPELLED)
    return {
      kind: "overflow",
      first: names[0]!,
      second: names[1]!,
      rest: names.length - NAMES_BEFORE_OTHERS,
      total: names.length,
    };
  return {
    kind: "list",
    text: locale.startsWith("zh")
      ? names.join("，")
      : // en-GB lists without the serial comma; en-US would add it.
        new Intl.ListFormat(locale === "en" ? "en-GB" : locale, { type: "conjunction" }).format(
          names,
        ),
    plural: names.length > 1,
  };
}
