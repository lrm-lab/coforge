import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import { activitySentenceLabel, agentDisplay, isBusyTone } from "./agent-activity-presentation";
import { agentMascot, type AgentMascot } from "./agent-mascot";
import { mascotActivity } from "./mascot-activity";
import type { MascotActivity } from "./mascot-rive-contract";

export type BusyAgent = {
  id: string;
  name: string;
  /** The Agent's handle (`LiveAgent.name`), for its card. */
  handle: string;
  avatarUrl?: string | null;
  /** The Agent's mascot: its creator's pick, else the one its id chooses. */
  mascot: AgentMascot;
  /** What that mascot acts out for the Agent's work. */
  activity: MascotActivity;
  /** The Agent's current Activity in sentence form ("running command"). */
  label: string;
  /** One of the viewer's own Agents, not another member's. */
  own: boolean;
};

/** An Agent of the Workspace's live list (`LiveAgent`). */
type BusyInput = {
  id: string;
  name: string;
  displayName: string;
  avatarUrl?: string | null;
  mascot?: AgentMascot;
  display?: AgentDisplaySnapshot;
  /** Set on an Agent outside the viewer's own roster (`LiveAgent.isExtra`). */
  isExtra?: true;
};

/** An Agent found busy, so with the display that says so. */
type PickedBusy<T extends BusyInput> = T & { display: AgentDisplaySnapshot };

/**
 * The Agents working or thinking right now, the one busy filter: the same objects in the same
 * order, so a store selecting with it repaints only when a busy Agent comes, goes or changes.
 */
export function pickBusyAgents<T extends BusyInput>(agents: readonly T[]): PickedBusy<T>[] {
  return agents.filter(
    (agent): agent is PickedBusy<T> =>
      agent.display !== undefined && isBusyTone(agent.display.activityKind),
  );
}

/**
 * The busy Agents (`pickBusyAgents`) as the header draws them, most relevant to the viewer first:
 * the ones they have a direct conversation with, then their own, then the rest, each group by name.
 */
export function rankBusyAgents(
  busy: readonly PickedBusy<BusyInput>[],
  directAgentIds: ReadonlySet<string>,
): BusyAgent[] {
  return busy
    .map((agent): BusyAgent => {
      const view = agentDisplay(agent.display);
      return {
        id: agent.id,
        name: agent.displayName.trim() || agent.name,
        handle: agent.name,
        avatarUrl: agent.avatarUrl,
        mascot: agentMascot(agent.id, agent.mascot),
        activity: mascotActivity(view.kind),
        label: activitySentenceLabel(view.label),
        own: !agent.isExtra,
      };
    })
    .sort(
      (a, b) =>
        Number(directAgentIds.has(b.id)) - Number(directAgentIds.has(a.id)) ||
        Number(b.own) - Number(a.own) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );
}
