/** One Computer a departure disconnects, as the preview server functions answer it. */
export type DepartingComputer = {
  id: string;
  name: string;
  displayName: string;
  agentCount: number;
  /** The Agents the caller may see; `agentCount` counts them all. */
  agents: { id: string; name: string; displayName: string }[];
};

export type DepartureSubject = { kind: "remove"; name: string } | { kind: "leave" };

/** The wording the sentences are built from, so they can be tested without a locale. */
export type DepartureCopy = {
  removeComputers: (input: { name: string; count: number; names: string }) => string;
  leaveComputers: (input: { count: number; names: string }) => string;
  agentsOffline: (input: { count: number }) => string;
  agentsOfflineNamed: (input: { count: number; names: string }) => string;
  computersMore: (input: { names: string; count: number }) => string;
  agentsMore: (input: { names: string; count: number }) => string;
  /** Joins names when some are left out ("a, b and 2 others"). */
  separator: string;
  /** Joins every name when none are left out ("a, b and c"). */
  list: (names: string[]) => string;
};

/** How many names a list shows before the rest are counted. */
export const SHOWN_NAMES = 3;

const labelOf = (named: { name: string; displayName: string }) =>
  named.displayName.trim() || named.name;

function nameList(
  labels: string[],
  total: number,
  copy: DepartureCopy,
  more: (input: { names: string; count: number }) => string,
) {
  const shown = labels.slice(0, SHOWN_NAMES);
  const left = total - shown.length;
  return left > 0 ? more({ names: shown.join(copy.separator), count: left }) : copy.list(shown);
}

/**
 * The sentences a departure's confirmation adds: which Computers disconnect and how many Agents on
 * them go offline. `null` when no Computer disconnects. The Agent count covers hidden Agents; only
 * the Agents the caller may see are named, and the rest are counted, never invented.
 */
export function departureImpactLines(
  computers: readonly DepartingComputer[],
  subject: DepartureSubject,
  copy: DepartureCopy,
): { computers: string; agents: string | null } | null {
  if (computers.length === 0) return null;
  const names = nameList(computers.map(labelOf), computers.length, copy, copy.computersMore);
  const sentence =
    subject.kind === "remove"
      ? copy.removeComputers({
          name: subject.name,
          count: computers.length,
          names,
        })
      : copy.leaveComputers({ count: computers.length, names });

  const agentCount = computers.reduce((sum, computer) => sum + computer.agentCount, 0);
  if (agentCount <= 0) return { computers: sentence, agents: null };
  const visible = computers.flatMap((computer) => computer.agents.map(labelOf));
  const agents =
    visible.length === 0
      ? copy.agentsOffline({ count: agentCount })
      : copy.agentsOfflineNamed({
          count: agentCount,
          names: nameList(visible, agentCount, copy, copy.agentsMore),
        });
  return { computers: sentence, agents };
}
