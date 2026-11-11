import { m } from "#src/paraglide/messages";
import { agentControlInFlight, type AgentControlState } from "./agent-control-realtime";

/**
 * Start on an offline Computer, one rule for every Start trigger (task #731). The Start still goes
 * through: the server keeps it until the Computer's next `ready` and the Agent starts then (task
 * #330). So a Start pending there is not running and shows no "Starting…"; the trigger says the
 * Computer is offline before it is pressed, and when the Agent will start once it is.
 */
export function offlineStart({
  computerOnline,
  agentOnline,
  control,
  requested,
  computerLabel,
}: {
  /** The assigned Computer's last-known connection state; `undefined` when unknown. */
  computerOnline?: boolean;
  agentOnline?: boolean;
  /** The Agent's latest control operation (`agent.control.v1`). */
  control?: AgentControlState;
  /** Start was pressed here while the Computer was offline. */
  requested: boolean;
  computerLabel?: string;
}) {
  const computerOffline = computerOnline === false;
  const waiting = computerOffline && control?.action === "start" && agentControlInFlight(control);
  const deferred = computerOffline && (waiting || requested);
  const deferredNote = m.agent_control_start_deferred_notice({
    computer: computerLabel ?? m.agent_form_computer(),
  });
  const note =
    computerOffline && !agentOnline
      ? deferred
        ? deferredNote
        : m.agent_error_banner_computer_offline()
      : undefined;
  return { computerOffline, waiting, deferred, deferredNote, note };
}
