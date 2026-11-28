import { StatusDot, type StatusTone } from "#src/components/ui/status-dot";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { TerminalUiStatus } from "./computer-terminal-state";

function statusPresentation(status: TerminalUiStatus): {
  tone: StatusTone;
  pulse: boolean;
  label: string;
} {
  switch (status) {
    case "connecting":
      return {
        tone: "warning",
        pulse: true,
        label: m.computer_terminal_status_connecting(),
      };
    case "connected":
      return {
        tone: "online",
        pulse: false,
        label: m.computer_terminal_status_connected(),
      };
    case "needs_upgrade":
      return {
        tone: "warning",
        pulse: false,
        label: m.computer_terminal_status_needs_upgrade(),
      };
    case "unauthorized":
      return {
        tone: "error",
        pulse: false,
        label: m.computer_terminal_status_unauthorized(),
      };
    case "unsupported":
      return {
        tone: "unknown",
        pulse: false,
        label: m.computer_terminal_status_unsupported(),
      };
    default:
      return {
        tone: "offline",
        pulse: false,
        label: m.computer_terminal_status_disconnected(),
      };
  }
}

export function ComputerTerminalStatusBadge({
  status,
  className,
}: {
  status: TerminalUiStatus;
  className?: string;
}) {
  const { tone, pulse, label } = statusPresentation(status);
  return (
    <span
      role="status"
      data-terminal-status={status}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-md border border-secondary bg-secondary px-2 py-0.5 text-xs font-medium whitespace-nowrap text-secondary",
        className,
      )}
    >
      <StatusDot tone={tone} pulse={pulse} className="size-1.5" />
      <span>{label}</span>
    </span>
  );
}
