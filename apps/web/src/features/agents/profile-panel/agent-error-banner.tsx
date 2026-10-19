import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import { Button } from "#src/components/base/buttons/button";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { ClockTime } from "#src/components/ui/relative-time";
import { StatusDot } from "#src/components/ui/status-dot";
import type { AgentDiagnosticFacts } from "#src/features/agents/agent-diagnostics";
import {
  ACTIVITY_CLOCK_CLASS,
  ACTIVITY_DOT_CLASS,
} from "#src/features/agents/agent-activity-timeline";
import { agentDisplay } from "#src/features/agents/agent-activity-presentation";
import { m } from "#src/paraglide/messages";
import { CopyDiagnosticsButton } from "./copy-diagnostics-button";

/**
 * The Agent's current error, under the panel header on every tab, for as long as the cloud
 * display says `error`: the provider's own wording after `Error:` (two lines; the whole of it on
 * hover), a copy of the Activity tab's diagnostic block and a way to that tab, except on the tab
 * itself, whose own band copies it. It leaves on its own once the display moves on.
 */
export function AgentErrorBanner({
  agent,
  display,
  onActivityTab,
  onViewLogs,
}: {
  agent: AgentDiagnosticFacts;
  display: AgentDisplaySnapshot;
  /** The Activity tab is open: the banner lines up with its log and leaves the copy to its band. */
  onActivityTab: boolean;
  /** Opens the Activity tab; absent when the viewer cannot see it. */
  onViewLogs?: () => void;
}) {
  // "Error: <detail>", the same label the DM header and the Activity log give this state.
  const label = agentDisplay(display).label;
  return (
    <div
      role="status"
      className="flex shrink-0 items-start gap-2 border-b border-secondary bg-error-primary py-2.5 pr-3.5 pl-5"
    >
      {/* The Activity log's own error marker. On that tab an invisible clock of the log's width
          puts the marker and the text in the log's columns, right above its error rows. */}
      {onActivityTab && (
        <span aria-hidden="true" className="invisible shrink-0">
          <ClockTime value={new Date(0)} plain className={ACTIVITY_CLOCK_CLASS} />
        </span>
      )}
      <StatusDot tone="error" className={ACTIVITY_DOT_CLASS} />
      <Tooltip title={label}>
        <TooltipTrigger className="min-w-0 flex-1 cursor-default rounded-xs text-left outline-focus-ring focus-visible:outline-2">
          <span className="line-clamp-2 text-sm break-words text-primary">{label}</span>
        </TooltipTrigger>
      </Tooltip>
      {!onActivityTab && (
        <div className="-my-1 flex shrink-0 items-center gap-1">
          <CopyDiagnosticsButton agent={agent} display={display} />
          {onViewLogs && (
            // Underlined at rest, not only on hover: a text link in a status line has to read as
            // one before the pointer finds it.
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
  );
}
