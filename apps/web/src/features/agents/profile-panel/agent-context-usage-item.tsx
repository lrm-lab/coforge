import { useEffect, useRef, useState } from "react";
import { HoverPopover } from "#src/components/ui/hover-popover";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { formatDateForDisplay } from "#src/lib/dates";
import { useTimeFormat } from "#src/lib/time-format-context";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { usedPercentText } from "#src/features/computers/runtime-usage";
import { type UsageRisk, usageRisk } from "#src/features/computers/usage-risk";
import { useAgentContextReport } from "#src/features/agents/agent-context-report";
import {
  AgentContextPopoverContent,
  contextUsedPercent,
} from "#src/features/agents/agent-context-popover";

/** A part of the Runtime pill that opens its own peek: a button with no chrome of its own, so the
 * pill reads as one, and a focus ring of its own for the keyboard. */
export const RUNTIME_PILL_PART_CLASS =
  "inline-flex items-center gap-1.5 rounded-sm outline-none data-focus-visible:ring-2 data-focus-visible:ring-brand";

/** The used share's text colour inside the Runtime pill: the pill's own text while fine, then the
 * semantic warning and error text tokens, by the same `usageRisk` rule as a usage bar. */
const CONTEXT_USED_TEXT_CLASS: Record<UsageRisk, string | undefined> = {
  success: undefined,
  warning: "text-warning-primary",
  error: "text-error-primary",
};

/**
 * The Agent's current context-window usage, the Runtime pill's second part: "Context 44% used",
 * its used share coloured by the same risk rule as a usage bar (`usageRisk`). Display only: nothing triggers
 * on a threshold. Hidden by the caller when there is no reading. The tooltip's observed time uses
 * the same `formatDateForDisplay` helper (workspace time zone, viewer locale) the Runtime usage
 * popover's `RelativeTime` already renders through.
 *
 * For a Claude Code Agent the item opens the context popover: hover shows the last stored report
 * with the same auto-refresh-once/Refresh pattern the Runtime usage popover uses. Other runtimes
 * keep the item + tooltip.
 */
export function ContextUsageItem({
  agentId,
  contextUsage,
  timeZone,
  supportsContextReport,
  computerOnline,
}: {
  agentId: string;
  contextUsage: { usedTokens: number; windowTokens: number; observedAtMs: number };
  timeZone: string | null;
  /** `runtime === RUNTIME_PROVIDER.CLAUDE_CODE` at the call site; only Claude Code has a
   * composition to read. */
  supportsContextReport: boolean;
  computerOnline?: boolean;
}) {
  const locale = getLocale();
  const timeFormat = useTimeFormat();
  const percent = contextUsedPercent(contextUsage.usedTokens, contextUsage.windowTokens);
  const numberFormat = new Intl.NumberFormat(locale);
  const used = usedPercentText(percent);
  const text = `${m.agent_context_title()} ${used}`;
  const item = (
    <span>
      {m.agent_context_title()}{" "}
      <span className={CONTEXT_USED_TEXT_CLASS[usageRisk(percent)]}>{used}</span>
    </span>
  );
  const tooltipText = m.agent_context_usage_tooltip({
    used: numberFormat.format(contextUsage.usedTokens),
    window: numberFormat.format(contextUsage.windowTokens),
    time: formatDateForDisplay(new Date(contextUsage.observedAtMs), timeZone, locale, timeFormat),
  });
  const context = useAgentContextReport(agentId, {
    enabled: supportsContextReport,
    computerOnline,
  });
  const [openCount, setOpenCount] = useState(0);
  const refreshButtonWrapRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (openCount > 0) refreshButtonWrapRef.current?.querySelector("button")?.focus();
  }, [openCount]);

  if (!supportsContextReport) {
    return (
      <Tooltip title={tooltipText}>
        <TooltipTrigger className={RUNTIME_PILL_PART_CLASS}>{item}</TooltipTrigger>
      </Tooltip>
    );
  }

  return (
    <HoverPopover
      label={`${text} · ${tooltipText}`}
      trigger={item}
      triggerClassName={RUNTIME_PILL_PART_CLASS}
      className="text-sm"
      working={context.scanning}
      onOpen={() => setOpenCount((count) => count + 1)}
    >
      <AgentContextPopoverContent
        usage={contextUsage}
        data={context.data}
        scanning={context.scanning}
        scanFailed={context.scanFailed}
        computerOnline={computerOnline}
        timeZone={timeZone}
        onRefresh={context.refresh}
        refreshButtonWrapRef={refreshButtonWrapRef}
      />
    </HoverPopover>
  );
}
