import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import { Button } from "#src/components/base/buttons/button";
import type { AgentDiagnosticFacts } from "#src/features/agents/agent-diagnostics";
import { ACTIVITY_MARKER_CLASS, ActivityMarker } from "#src/features/agents/activity-marker";
import { AgentStatusMarker } from "#src/features/agents/agent-status-marker";
import { agentDisplay } from "#src/features/agents/agent-status-display";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { CopyDiagnosticsButton } from "./copy-diagnostics-button";

export function AgentErrorBanner({
  agent,
  display,
  onActivityTab,
  onViewLogs,
  needsManualStart,
  canRetryManualStart,
  retry,
}: {
  agent: AgentDiagnosticFacts;
  display: AgentDisplaySnapshot;
  onActivityTab: boolean;
  onViewLogs?: () => void;
  needsManualStart?: boolean;
  canRetryManualStart?: boolean;
  retry?: AgentRetry;
}) {
  const status = agentDisplay(display);
  const label = status.alertText || status.label;
  const existingRecovery =
    retry && (!status.isOnline || status.alert) ? status.recovery : undefined;
  const recovery =
    needsManualStart && existingRecovery !== "reset_session"
      ? canRetryManualStart
        ? "retry"
        : undefined
      : existingRecovery;
  const showRecovery = recovery && !(recovery === "retry" && retry?.computerOffline);
  const resetBlocked = recovery === "reset_session" && retry?.computerOffline === true;
  const retryNote = resetBlocked ? m.agent_error_banner_computer_offline() : retry?.note;
  const showLinks = !onActivityTab && onViewLogs;
  return (
    <div
      role="status"
      className="flex shrink-0 items-start gap-3 border-b border-secondary bg-error-primary py-2.5 pr-3.5 pl-5"
    >
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
          (status.alert || needsManualStart) && "flex-col gap-1",
        )}
      >
        <span className="min-w-0 flex-1 text-sm break-words text-primary">
          {label}
          {needsManualStart && ` ${m.agent_automatic_start_stopped()}`}
        </span>
        {(showRecovery || showLinks) && (
          <div className="-my-1 flex shrink-0 items-center gap-1">
            {showRecovery && retry && (
              <>
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

export type AgentRetry = {
  onRetry: () => void;
  onResetSession: () => void;
  busy: boolean;
  deferred: boolean;
  note?: string;
  computerOffline: boolean;
};
