import { AlertTriangle } from "@untitledui/icons";

import { StatusDot } from "#src/components/ui/status-dot";
import type { agentDisplay } from "./agent-status-display";

/**
 * What sits before an Agent's status word (task #667): its dot, or, for a state someone has to
 * act on, a warning sign in place of the dot, so no state wears two marks.
 */
export function AgentStatusMarker({
  status,
  className,
}: {
  status: ReturnType<typeof agentDisplay>;
  className?: string;
}) {
  return status.alert ? (
    <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0 text-fg-error-primary" />
  ) : (
    <StatusDot tone={status.tone} pulse={status.pulse} className={className} />
  );
}

/** An Agent's status under its name in a list; a state to act on carries its warning sign. */
export function AgentStatusLine({ status }: { status: ReturnType<typeof agentDisplay> }) {
  if (!status.alert)
    return <span className="block truncate text-xs text-tertiary">{status.label}</span>;
  return (
    <span className="flex min-w-0 items-center gap-1 text-xs text-error-primary">
      <AgentStatusMarker status={status} />
      <span className="truncate">{status.label}</span>
    </span>
  );
}
