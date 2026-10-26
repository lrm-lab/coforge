import { useHydrated } from "@tanstack/react-router";

import { ProgressBarBase } from "#src/components/base/progress-indicators/progress-indicators";
import { RelativeTime } from "#src/components/ui/relative-time";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { USAGE_RISK_FILL_CLASS, usageRisk } from "./usage-risk";
import type { UsageResultRecord } from "#src/server/centrifugo/usage-cache.server";

/** Stands in for `{time}` while a message is split around the `RelativeTime` that replaces it. */
const TIME_SLOT = "\u0000";

/**
 * A message with a live `RelativeTime` where its `{time}` goes: "resets in 5d" / "5天后重置",
 * "Updated 6m ago" / "6分钟前更新". The message decides the word order, so each locale keeps its
 * own. Callers render it only once hydrated, as `RelativeTime` is blank before that.
 */
export function TimeMessage({
  message,
  value,
  timeZone,
}: {
  message: (time: string) => string;
  value: string | Date;
  timeZone: string | null;
}) {
  const [before = "", after = ""] = message(TIME_SLOT).split(TIME_SLOT);
  return (
    <>
      {before}
      <RelativeTime value={value} timeZone={timeZone} plain />
      {after}
    </>
  );
}

/** "63% used" / "已用 63%": the one wording for a used share, a usage window's or a context's. */
export function usedPercentText(usedPercent: number): string {
  return m.computer_usage_percent_used({ percent: formatPercent(usedPercent) });
}

/**
 * One usage meter row: the label, then the value and its reset on the same line, then a bar
 * coloured by `usageRisk` on the used share. The Agent context popover draws its context window
 * with the same row (`resetExpected={false}`: a context window has no reset).
 */
export function UsageWindow({
  label,
  window,
  creditUsage,
  detail,
  note,
  timeZone,
  resetExpected = true,
  showLeft = false,
}: {
  label: string;
  window: {
    usedPercent?: number;
    status?: "ok" | "limit_reached" | "parse_unavailable";
    resetsAt?: string;
  };
  creditUsage?: NonNullable<UsageResultRecord["snapshot"]>["creditUsage"];
  /** Official figure that is not a percent, shown in place of a meter. */
  detail?: string;
  /** Official amount kept beside a meter, such as a spend limit's used and limit strings. */
  note?: string;
  timeZone: string | null;
  /** False for a meter that never resets. Otherwise a used share whose reset the provider did not
   * report says so; a row without a share (a balance, a trial) never claims a reset. */
  resetExpected?: boolean;
  /** A provider quota reads as the share left and its bar fills with it, as on Raft. A context
   * window keeps the used share. */
  showLeft?: boolean;
}) {
  // The header line is label + a short value + reset, kept on one line: a credit plan's amounts
  // ("7,517.29 / 10,000 credits used") would squeeze the label onto two lines in the popover, so
  // they move under the bar and the header shows the used share, like a session window (task #109).
  const hydrated = useHydrated();
  const resetUnknown =
    resetExpected && window.usedPercent !== undefined && window.resetsAt === undefined;
  const used =
    window.usedPercent === undefined ? undefined : Math.min(100, Math.max(0, window.usedPercent));
  const value =
    used !== undefined
      ? showLeft
        ? m.computer_usage_percent_left({ percent: formatPercent(100 - used) })
        : usedPercentText(used)
      : creditUsage
        ? creditAmounts(creditUsage)
        : detail
          ? detail
          : window.status === "parse_unavailable"
            ? m.computer_usage_badge_unavailable()
            : window.status === "limit_reached"
              ? m.computer_usage_limit_reached()
              : m.computer_usage_available();

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <p className="min-w-0 truncate font-medium text-secondary">{label}</p>
        <p className="shrink-0 text-tertiary tabular-nums">
          <span className="font-medium text-primary">{value}</span>
          {hydrated && window.resetsAt !== undefined && (
            <>
              {" · "}
              <TimeMessage
                message={(time) => m.computer_usage_resets({ time })}
                value={window.resetsAt}
                timeZone={timeZone}
              />
            </>
          )}
          {resetUnknown && ` · ${m.computer_usage_reset_unavailable()}`}
        </p>
      </div>
      {used !== undefined && (
        // Untitled's own ProgressBarBase draws the bar (task #109); it takes no accessible name,
        // so the group around it carries the window's label for screen readers.
        <div role="group" aria-label={label} className="mt-1.5">
          <ProgressBarBase
            value={showLeft ? 100 - used : used}
            className="h-1.5 rounded-full"
            progressClassName={cn(
              "rounded-full",
              USAGE_RISK_FILL_CLASS[usageRisk(used, window.status === "limit_reached")],
            )}
          />
        </div>
      )}
      {creditUsage && (window.usedPercent !== undefined || creditUsage.overage > 0) && (
        <p className="mt-1 text-xs tabular-nums text-tertiary">
          {window.usedPercent !== undefined && creditAmounts(creditUsage)}
          {window.usedPercent !== undefined && creditUsage.overage > 0 && " · "}
          {creditUsage.overage > 0 &&
            m.computer_usage_credit_overage({ overage: formatCredits(creditUsage.overage) })}
        </p>
      )}
      {note && <p className="mt-1 text-xs break-words tabular-nums text-tertiary">{note}</p>}
    </div>
  );
}

/** A used share as a whole percentage ("76%"): the exact credit amounts, when there are any, sit
 * under the bar, so the header does not need decimals. */
function formatPercent(value: number) {
  return new Intl.NumberFormat(getLocale(), { style: "percent", maximumFractionDigits: 0 }).format(
    value / 100,
  );
}

/** Credits as the locale writes numbers: grouped, at most two decimals ("7,517.29"). */
function formatCredits(value: number) {
  return new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 2 }).format(value);
}

function creditAmounts(creditUsage: { used: number; limit: number }) {
  return m.computer_usage_credit_amounts({
    used: formatCredits(creditUsage.used),
    limit: formatCredits(creditUsage.limit),
  });
}
