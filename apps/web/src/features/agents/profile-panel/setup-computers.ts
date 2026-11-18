import { m } from "#src/paraglide/messages";

export function setupComputerOptions(
  computers: readonly {
    id: string;
    kind: string;
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
      kind: computer.kind,
      name: computer.name ?? "",
      displayName: computer.displayName || computer.name || m.agent_computer_unnamed(),
      online: Boolean(computer.online),
    }));
}
