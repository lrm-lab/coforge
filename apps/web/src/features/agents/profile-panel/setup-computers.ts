import { m } from "#src/paraglide/messages";

/** The Computers an unbound Agent's runtime setup offers: a weekly-report assistant only its
 * viewer's own, each named, with whether it is online. */
export function setupComputerOptions(
  computers: readonly {
    id: string;
    name?: string | null;
    displayName?: string | null;
    online?: boolean;
    ownedByCurrentUser?: boolean;
  }[],
  isWeeklyReportAssistant: boolean | undefined,
) {
  return computers
    .filter((computer) => !isWeeklyReportAssistant || computer.ownedByCurrentUser)
    .map((computer) => ({
      id: computer.id,
      displayName: computer.displayName || computer.name || m.agent_computer_unnamed(),
      online: Boolean(computer.online),
    }));
}
