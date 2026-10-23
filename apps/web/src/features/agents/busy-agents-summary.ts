import { activitySentenceLabel, agentDisplay } from "./agent-activity-presentation";
import { agentMascot, type AgentMascot } from "./agent-mascot";
import { mascotActivity } from "./mascot-activity";
import type { MascotActivity } from "./mascot-rive-contract";
import type { LiveAgent } from "./workspace-agents-realtime";

/** The most names a group spells out; a longer group shows two and counts the rest. */
const MAX_NAMES_SPELLED = 3;
const NAMES_BEFORE_OTHERS = 2;
const GROUP_SEPARATOR = " · ";

export type BusyAgent = {
  id: string;
  name: string;
  /** The Agent's mascot: its creator's pick, else the one its id chooses. */
  mascot: AgentMascot;
  /** What that mascot acts out for the Agent's work. */
  activity: MascotActivity;
  /** The Agent's current Activity in sentence form ("running command"). */
  label: string;
};

/** How the line is worded, supplied by the caller so this module reads no global locale. */
export type SummaryWording = {
  locale: string;
  /** The last list element of a long group, standing for the names it leaves out ("2 others"). */
  others: (count: number) => string;
};

/** A name takes the stronger weight in the line; every other part is secondary text. */
export type SummaryPart = { kind: "name" | "text"; text: string };

/**
 * The members of a conversation that are working or thinking right now, wherever they are busy,
 * ordered by name so the line does not reshuffle as the live roster changes.
 */
export function busyAgentsAmong(
  agents: readonly Pick<LiveAgent, "id" | "name" | "displayName" | "mascot" | "display">[],
  memberIds: Iterable<string>,
): BusyAgent[] {
  const members = new Set(memberIds);
  return agents
    .flatMap((agent) => {
      if (!members.has(agent.id)) return [];
      const display = agentDisplay(agent.display);
      if (!display.pulse) return [];
      return [
        {
          id: agent.id,
          name: agent.displayName.trim() || agent.name,
          mascot: agentMascot(agent.id, agent.mascot),
          activity: mascotActivity(display.kind),
          label: activitySentenceLabel(display.label),
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** One group's names as a localized list; a long group's last element is the count of the rest. */
function namesOf(names: readonly string[], { locale, others }: SummaryWording): SummaryPart[] {
  const spelled = names.length > MAX_NAMES_SPELLED ? names.slice(0, NAMES_BEFORE_OTHERS) : names;
  const items =
    spelled.length < names.length ? [...spelled, others(names.length - spelled.length)] : spelled;
  let element = 0;
  return new Intl.ListFormat(locale, { type: "conjunction" })
    .formatToParts(items)
    .map(({ type, value }): SummaryPart => {
      if (type === "literal") return { kind: "text", text: value };
      return { kind: element++ < spelled.length ? "name" : "text", text: value };
    });
}

/**
 * The busy line as parts: Agents sharing a label are one group ("Atlas and Sam running command"),
 * groups sit in order of their first Agent and are separated by a middle dot. Empty when no Agent
 * is busy.
 */
export function summarizeBusyAgents(
  busy: readonly BusyAgent[],
  wording: SummaryWording,
): SummaryPart[] {
  const groups = new Map<string, string[]>();
  for (const agent of busy)
    groups.set(agent.label, [...(groups.get(agent.label) ?? []), agent.name]);
  return [...groups].flatMap(([label, names], index) => [
    ...(index === 0 ? [] : [{ kind: "text" as const, text: GROUP_SEPARATOR }]),
    ...namesOf(names, wording),
    { kind: "text" as const, text: ` ${label}` },
  ]);
}
