import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import { Button } from "#src/components/base/buttons/button";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import type { AgentDiagnosticFacts } from "#src/features/agents/agent-diagnostics";
import { ACTIVITY_MARKER_CLASS, ActivityMarker } from "#src/features/agents/activity-marker";
import { agentDisplay } from "#src/features/agents/agent-activity-presentation";
import { m } from "#src/paraglide/messages";
import { CopyDiagnosticsButton } from "./copy-diagnostics-button";

function failureReasonText(reason: string): string {
  switch (reason) {
    case "runtime_private":
      return "运行时已改为私有或不对你公开";
    case "runtime_not_installed":
      return "电脑上未安装该运行时";
    case "runtime_unusable":
      return "电脑上的运行时不可用";
    case "runtime_unavailable":
      return "运行时在电脑上不可用或未公开";
    case "runtime_login_required":
      return "运行时需要在电脑上登录";
    case "runtime_start_failed":
      return "运行时启动失败";
    case "agent_authorization_failed":
      return "Agent 启动鉴权失败";
    default:
      return `启动失败：${reason}`;
  }
}

/**
 * The Agent's current error, under the panel header on every tab, for as long as the cloud
 * display says `error` or an unrecoverable failure reason is recorded: the provider's own wording
 * after `Error:` (two lines; the whole of it on hover), and, for whoever gets the Activity tab,
 * a copy of its diagnostic block and a way to it, except on the tab itself, whose own band copies
 * it. It leaves on its own once the display moves on or the failure reason is cleared.
 */
export function AgentErrorBanner({
  agent,
  display,
  failureReason,
  onActivityTab,
  onViewLogs,
}: {
  agent: AgentDiagnosticFacts;
  display?: AgentDisplaySnapshot;
  failureReason?: string | null;
  /** The Activity tab is open: the banner leaves the copy to its band. */
  onActivityTab: boolean;
  /** Opens the Activity tab; absent when the viewer cannot see it, and the diagnostics copy (which
   * reads the tab's feed) goes with it. */
  onViewLogs?: () => void;
}) {
  // "Error: <detail>", or the typed failure reason label when no live error activity snapshot is held.
  const label = display ? agentDisplay(display).label : failureReasonText(failureReason ?? "");
  return (
    <div
      role="status"
      className="flex shrink-0 items-start gap-3 border-b border-secondary bg-error-primary py-2.5 pr-3.5 pl-5"
    >
      {/* The Activity log's own error marker, at the log's inset and gap, so on that tab the
          marker and the text sit in the log's columns, right above its error rows. */}
      <ActivityMarker tone="error" className={ACTIVITY_MARKER_CLASS} />
      <Tooltip title={label}>
        <TooltipTrigger className="min-w-0 flex-1 cursor-default rounded-xs text-left outline-focus-ring focus-visible:outline-2">
          <span className="line-clamp-2 text-sm break-words text-primary">{label}</span>
        </TooltipTrigger>
      </Tooltip>
      {!onActivityTab && onViewLogs && (
        <div className="-my-1 flex shrink-0 items-center gap-1">
          <CopyDiagnosticsButton agent={agent} display={display} />
          {/* Underlined at rest, not only on hover: a text link in a status line has to read as
              one before the pointer finds it. */}
          <Button
            color="link-gray"
            size="sm"
            className="*:data-text:decoration-fg-quaternary *:data-text:underline-offset-2"
            onPress={onViewLogs}
          >
            {m.agent_error_banner_view_logs()}
          </Button>
        </div>
      )}
    </div>
  );
}
