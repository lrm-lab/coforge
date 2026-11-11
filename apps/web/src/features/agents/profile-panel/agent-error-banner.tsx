import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import { Button } from "#src/components/base/buttons/button";
import type { AgentDiagnosticFacts } from "#src/features/agents/agent-diagnostics";
import { ACTIVITY_MARKER_CLASS, ActivityMarker } from "#src/features/agents/activity-marker";
import { AgentStatusMarker } from "#src/features/agents/agent-status-marker";
import { agentDisplay } from "#src/features/agents/agent-status-display";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { CopyDiagnosticsButton } from "./copy-diagnostics-button";

/**
 * The Agent's current error, under the panel header on every tab, for as long as the cloud
 * display says `error`: the provider's own wording after `Error:`, in full, and, for whoever gets
 * the Activity tab, a copy of its diagnostic block and a way to it, except on the tab itself,
 * whose own band copies it. It leaves on its own once the display moves on.
 */
export function AgentErrorBanner({
  agent,
  display,
  onActivityTab,
  onViewLogs,
  retry,
}: {
  agent: AgentDiagnosticFacts;
  display: AgentDisplaySnapshot;
  /** The Activity tab is open: the banner leaves the copy to its band. */
  onActivityTab: boolean;
  /** Opens the Activity tab; absent when the viewer cannot see it, and the diagnostics copy (which
   * reads the tab's feed) goes with it. */
  onViewLogs?: () => void;
  /** Gets the Agent going again (task #731): offered while it is stopped for a reason only a
   * person clears, so whoever fixed the cause restarts it where they read it. */
  retry?: AgentRetry;
}) {
  // "Error: <detail>", the same label the DM header and the Activity log give this state.
  const status = agentDisplay(display);
  const label = status.alertText || status.label;
  // A stopped Agent waits for a person; one still running retries on its own.
  const recovery = retry && !status.isOnline ? status.recovery : undefined;
  const resetBlocked = recovery === "reset_session" && retry?.computerOffline === true;
  const retryNote = resetBlocked ? m.agent_error_banner_computer_offline() : retry?.note;
  const showLinks = !onActivityTab && onViewLogs;
  return (
    <div
      role="status"
      className="flex shrink-0 items-start gap-3 border-b border-secondary bg-error-primary py-2.5 pr-3.5 pl-5"
    >
      {/* The Activity log's own error marker, at the log's inset and gap, so on that tab the
          marker and the text sit in the log's columns, right above its error rows. */}
      {status.alert ? (
        <span className="flex h-5 shrink-0 items-center">
          <AgentStatusMarker status={status} />
        </span>
      ) : (
        <ActivityMarker tone="error" className={ACTIVITY_MARKER_CLASS} />
      )}
      <div
        className={cn(
          "flex min-w-0 flex-1 items-start gap-3",
          // A sentence of what to do needs the width: the actions go under it.
          status.alert && "flex-col gap-1",
        )}
      >
        <span className="min-w-0 flex-1 text-sm break-words text-primary">{label}</span>
        {(recovery || showLinks) && (
          <div className="-my-1 flex shrink-0 items-center gap-1">
            {recovery && retry && (
              <>
                {/* Retry is the panel's Start, under its one rule (task #731): on an offline
                    Computer it still goes through and waits for the Computer, and the note
                    beside it says so; Reset session needs the Computer there. */}
                <Button
                  color="secondary"
                  size="sm"
                  isDisabled={retry.busy || resetBlocked}
                  onPress={recovery === "reset_session" ? retry.onResetSession : retry.onRetry}
                >
                  {recovery === "reset_session"
                    ? m.agent_error_banner_reset_session()
                    : retry.busy && !retry.deferred
                      ? m.agent_control_start_pending()
                      : m.agent_error_banner_retry()}
                </Button>
                {retryNote && <span className="px-1.5 text-sm text-tertiary">{retryNote}</span>}
                <span className="w-1" aria-hidden="true" />
              </>
            )}
            {showLinks && <CopyDiagnosticsButton agent={agent} display={display} />}
            {/* Underlined at rest, not only on hover: a text link in a status line has to read as
                one before the pointer finds it. */}
            {showLinks && (
              <Button
                color="link-gray"
                size="sm"
                className="*:data-text:decoration-fg-quaternary *:data-text:underline-offset-2"
                onPress={onViewLogs}
              >
                {m.agent_error_banner_view_logs()}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** The banner's way back for a stop a person cleared (`agentDisplay().recovery`): the panel's
 * Start, or its Reset session (`useAgentRuntimeControls`), busy while any control runs. Start
 * keeps the controls' offline rule (`deferred`, `note`); Reset session is not offered while the
 * Agent's Computer is offline. */
export type AgentRetry = {
  onRetry: () => void;
  onResetSession: () => void;
  busy: boolean;
  deferred: boolean;
  note?: string;
  computerOffline: boolean;
};
