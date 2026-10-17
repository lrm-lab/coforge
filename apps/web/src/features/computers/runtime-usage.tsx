import { RefreshCw01 as RefreshCw } from "@untitledui/icons";
import { useId, useState, type ReactNode } from "react";
import { useHydrated } from "@tanstack/react-router";

import {
  RUNTIME_PROVIDER_SUPPORTS_USAGE_SCAN,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
import { Badge } from "#src/components/base/badges/badges";
import { ProgressBarBase } from "#src/components/base/progress-indicators/progress-indicators";
import { Button } from "#src/components/base/buttons/button";
import { Skeleton } from "#src/components/ui/skeleton";
import { HoverPopover } from "#src/components/ui/hover-popover";
import { RelativeTime } from "#src/components/ui/relative-time";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { RuntimeProviderMark } from "#src/features/agents/runtime-provider-mark";
import { useRuntimeUsage } from "./use-runtime-usage";
import { byDuration, usageWindowLabel } from "./runtime-usage-windows";
import type { UsageReadResult, UsageResultRecord } from "#src/server/centrifugo/usage-cache.server";

export type Runtime = {
  provider: RuntimeProvider;
  /** The CLI's own reported version, when known — e.g. absent for the Agent profile panel until
   * its Computer has reported one. */
  version?: string;
  displayName: string;
};

/** "ok" only when the last read is fresh, available, and no usage window is at its limit. */
export type UsageHealth = "ok" | "attention";

function RuntimeIdentity({ runtime, health }: { runtime: Runtime; health?: UsageHealth }) {
  return (
    <span className="flex min-w-0 items-center gap-3">
      <RuntimeProviderMark provider={runtime.provider} className="size-6" />
      <span className="min-w-0">
        <span className="flex items-center gap-1.5">
          <span className="block truncate font-medium text-primary">{runtime.displayName}</span>
          <UsageHealthDot health={health} />
        </span>
        {runtime.version && (
          <span className="mt-0.5 block truncate text-xs text-tertiary">{runtime.version}</span>
        )}
      </span>
    </span>
  );
}

/** A small health indicator for a Runtime trigger — reuses the same dot styling the Agent
 * profile panel already draws for a Computer's connected/offline state. */
export function UsageHealthDot({
  health,
  className,
}: {
  health?: UsageHealth;
  className?: string;
}) {
  if (!health) return null;
  return (
    <span
      role="img"
      aria-label={
        health === "ok" ? m.computer_usage_health_ok() : m.computer_usage_health_attention()
      }
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        health === "ok" ? "bg-success-solid" : "bg-warning-solid",
        className,
      )}
    />
  );
}

const DEFAULT_TRIGGER_CLASS_NAME =
  "-m-1 min-w-0 rounded-lg p-1 text-left outline-none hover:bg-primary_hover data-focus-visible:ring-2 data-focus-visible:ring-brand";

/**
 * One Code Agent runtime on a Computer, and the shared provider-usage popover: reads the cached
 * usage on mount, refreshes it with at most one automatic scan when that read is stale or missing
 * and the Computer isn't known offline, and offers a manual Refresh for everything else. A
 * caller without the default `RuntimeIdentity` row (the Agent profile panel's Runtime badge)
 * supplies its own `trigger`, which receives the same health signal `RuntimeIdentity` draws as a
 * dot so both triggers can show it.
 */
export function RuntimeUsage({
  computerId,
  runtime,
  computerOnline,
  timeZone = null,
  trigger,
  triggerClassName,
  footer,
}: {
  computerId: string;
  runtime: Runtime;
  /** `undefined` means "not known", treated like online for the purpose of auto-scanning. */
  computerOnline?: boolean;
  timeZone?: string | null;
  trigger?: (health: UsageHealth | undefined) => ReactNode;
  triggerClassName?: string;
  /** Controls for this runtime under its usage (the Computer page's Public switch). With a
   * footer, a runtime that reports no usage still opens a popover, holding only the footer. */
  footer?: ReactNode;
}) {
  const supportsUsage = RUNTIME_PROVIDER_SUPPORTS_USAGE_SCAN[runtime.provider];
  const usage = useRuntimeUsage(computerId, runtime.provider, {
    enabled: supportsUsage,
    computerOnline,
  });

  const health = supportsUsage ? usageHealth(usage.data) : undefined;
  const resolvedTrigger = trigger ? (
    trigger(health)
  ) : (
    <RuntimeIdentity runtime={runtime} health={health} />
  );

  if (!supportsUsage && !footer) return resolvedTrigger;

  const content = () => (
    <RuntimeUsagePopoverContent
      runtime={runtime}
      showUsage={supportsUsage}
      data={usage.data}
      scanning={usage.scanning}
      scanFailed={usage.scanFailed}
      computerOnline={computerOnline}
      timeZone={timeZone}
      onRefresh={usage.refresh}
      footer={footer}
    />
  );
  const label = supportsUsage
    ? `${runtime.displayName} · ${m.computer_usage_title()}`
    : runtime.displayName;

  return (
    <HoverPopover
      label={label}
      trigger={resolvedTrigger}
      triggerClassName={triggerClassName ?? DEFAULT_TRIGGER_CLASS_NAME}
      className="max-h-[calc(100dvh-4rem)] text-sm"
      working={usage.scanning}
    >
      {content()}
    </HoverPopover>
  );
}

function usageHealth(data: UsageReadResult | undefined): UsageHealth | undefined {
  if (!data?.result) return undefined;
  const badge = usageBadge(data.result);
  if (!badge) return undefined;
  return badge.color === "success" && data.state === "fresh" ? "ok" : "attention";
}

const USAGE_READER_NOT_CONNECTED = "Usage reader is not connected yet";

function usageBadge(
  result: UsageResultRecord,
): { color: "success" | "warning" | "error"; label: string } | undefined {
  if (result.status === "reauth")
    return { color: "warning", label: m.computer_usage_badge_reauth() };
  if (result.status === "unavailable")
    return { color: "warning", label: m.computer_usage_badge_unavailable() };
  if (result.status === "error") return { color: "error", label: m.computer_usage_badge_error() };
  if (result.status === "unsupported")
    return {
      color: "warning",
      label:
        result.message === USAGE_READER_NOT_CONNECTED
          ? m.computer_usage_not_connected()
          : m.computer_usage_badge_unsupported(),
    };
  const rateLimited =
    result.snapshot?.health === "rate_limited" ||
    result.snapshot?.primary?.status === "limit_reached" ||
    result.snapshot?.secondary?.status === "limit_reached" ||
    result.snapshot?.officialGroups?.some((group) =>
      group.buckets.some((bucket) => bucket.status === "limit_reached"),
    ) === true;
  return rateLimited
    ? { color: "warning", label: m.computer_usage_limit_reached() }
    : { color: "success", label: m.computer_usage_badge_ok() };
}

function usageFailureDescription(result: UsageResultRecord | undefined) {
  const status = result?.status;
  if (status === "reauth") return m.computer_usage_reauth();
  if (status === "unavailable") return m.computer_usage_unavailable_description();
  if (status === "error") return m.computer_usage_error();
  if (status === "unsupported")
    return result?.message === USAGE_READER_NOT_CONNECTED
      ? m.computer_usage_not_connected()
      : m.computer_usage_status_unsupported();
  return undefined;
}

/** Window keys we store when the provider has no display name. They are not official copy. */
const RAW_WINDOW_LABELS: Record<string, () => string> = {
  onDemand: () => m.computer_usage_pay_as_you_go(),
  prepaidBalance: () => m.computer_usage_prepaid_balance(),
  individualLimit: () => m.computer_usage_spend_limit_remaining(),
  bonus: () => m.computer_usage_bonus(),
  freeTrial: () => m.computer_usage_free_trial(),
  currentPeriod: () => m.computer_usage_current_period(),
};

/** The row label for one official bucket. A provider name wins. A stored window key is
 * localized, then a real window length, then a week or month named by the official type. */
function officialBucketLabel(bucket: {
  name?: string;
  window?: string;
  windowDurationMinutes?: number;
}): string {
  if (bucket.name && !RAW_WINDOW_LABELS[bucket.name]) return bucket.name;
  const key = bucket.window ?? bucket.name;
  const known = key ? RAW_WINDOW_LABELS[key] : undefined;
  if (known) return known();
  if (bucket.windowDurationMinutes)
    return byDuration({ windowDurationMinutes: bucket.windowDurationMinutes });
  if (key && /week/iu.test(key)) return m.computer_usage_weekly();
  if (key && /month/iu.test(key)) return m.computer_usage_monthly();
  return key ?? m.computer_usage_available();
}

/** A figure that is not a percent, such as a wrapped balance. Omitted when the row already
 * has a meter, so a bucket note does not replace the official percent. */
function officialBucketDetail(bucket: {
  description?: string;
  remainingFraction?: number;
  usedPercent?: number;
}): string | undefined {
  if (bucket.remainingFraction !== undefined || bucket.usedPercent !== undefined) return undefined;
  return bucket.description;
}

/**
 * The popover's pure body: everything `RuntimeUsage` fetches, rendered without touching a query
 * client itself, so a test can render it directly with a plain `data` fixture. Three bands split
 * by full-width rules: the runtime (version, freshness, Refresh), its account (status, reason,
 * usage windows), and the caller's `footer`.
 */
export function RuntimeUsagePopoverContent({
  runtime,
  showUsage = true,
  data,
  scanning,
  scanFailed = false,
  computerOnline,
  timeZone = null,
  onRefresh,
  footer,
}: {
  runtime: Pick<Runtime, "provider" | "displayName" | "version">;
  /** False for a runtime that reports no usage: only the runtime band and the footer show. */
  showUsage?: boolean;
  data?: UsageReadResult;
  scanning: boolean;
  scanFailed?: boolean;
  computerOnline?: boolean;
  timeZone?: string | null;
  onRefresh: () => void;
  /** Present when the popover opened on a press: draws its close button. */

  footer?: ReactNode;
}) {
  const hydrated = useHydrated();
  const notesId = useId();
  const [notesOpen, setNotesOpen] = useState(false);
  const snapshot = data?.result?.snapshot;
  const badge = data?.result ? usageBadge(data.result) : undefined;
  const reason =
    computerOnline === false
      ? m.computer_usage_offline()
      : scanFailed
        ? m.computer_usage_no_response()
        : usageFailureDescription(data?.result);
  const reading =
    !reason && (!data || (data.state === "missing" && (scanning || data.pendingScanId)));
  const plan = snapshot?.planType ? formatPlan(snapshot.planType) : undefined;
  const accountLabel = snapshot?.accountLabel;
  // Codex reports whether credits exist and whether they are unlimited, and a balance string
  // only when that version's schema sends one. No amounts, so this stays a note, not a bar.
  const credits = snapshot?.credits?.unlimited
    ? m.computer_usage_credits_unlimited()
    : snapshot?.credits?.hasCredits
      ? m.computer_usage_credits_available()
      : undefined;
  const accountNote = [plan && accountLabel, credits, snapshot?.credits?.balance]
    .filter(Boolean)
    .join(" · ");
  const windows = snapshot
    ? (["primary", "secondary"] as const).flatMap((key) => {
        const window = snapshot[key];
        return window ? [{ key, window }] : [];
      })
    : [];
  const hasUsageNotes = Boolean(
    snapshot?.officialDescription || snapshot?.officialGroups?.some((group) => group.description),
  );

  return (
    <div className="divide-y divide-secondary">
      {/* Identity row (task #109): mark, name over "version · read time", then the icon actions,
          all centred on the two text lines so Refresh no longer hangs off the second one. Refresh
          is an icon button with a tooltip, the same shape as the runtime field's refresh. */}
      <div className="flex items-center gap-3 px-4 py-3">
        <RuntimeProviderMark provider={runtime.provider} className="size-8 shrink-0" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold text-primary">{runtime.displayName}</h2>
          <p className="truncate text-xs text-tertiary">
            {runtime.version}
            {/* RelativeTime is blank until hydration; the separator waits with it. */}
            {hydrated && showUsage && data?.result && (
              <>
                {runtime.version ? " · " : ""}
                <RelativeTime value={data.result.collectedAt} timeZone={timeZone} plain />
              </>
            )}
          </p>
        </div>
        {showUsage && (
          // Two React Aria behaviours keep the peek open across a refresh (task #109):
          // - `isLoading` is React Aria's `isPending`: the button ignores presses but keeps focus.
          //   `isDisabled` would drop focus to the page mid-press, and the peek follows focus out.
          // - No Tooltip. PreviewTrigger shares React Aria's one-open-tooltip-at-a-time state, so a
          //   tooltip opening inside the peek closes the peek. The aria-label names the button.
          <Button
            size="xs"
            color="tertiary"
            iconLeading={RefreshCw}
            aria-label={scanning ? m.computer_usage_refreshing() : m.computer_usage_refresh()}
            isLoading={scanning}
            isDisabled={computerOnline === false}
            className="shrink-0"
            onPress={onRefresh}
          />
        )}
      </div>

      {showUsage && (
        <section className="px-4 py-3">
          {/* The account band leads with the plan, then the signed-in account. A credits note
              counts too: Codex can report credits with no plan and no email, and that note used
              to show under the fallback heading. The empty "Runtime account" line is omitted
              only when the runtime names nothing and nothing is wrong. The badge speaks only
              when something needs the reader — reauth, an error, a limit — since "OK" repeats
              the health dot that opened this popover. */}
          {(plan || accountLabel || accountNote || (badge && badge.color !== "success")) && (
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-medium text-primary">
                  {plan || accountLabel || m.computer_usage_account()}
                </h3>
                {accountNote && <p className="truncate text-xs text-tertiary">{accountNote}</p>}
              </div>
              {badge && badge.color !== "success" && (
                <Badge color={badge.color} size="sm" className="shrink-0">
                  {badge.label}
                </Badge>
              )}
            </div>
          )}
          {reading ? (
            <div aria-label={m.computer_usage_reading()} className="mt-3 space-y-3">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          ) : (
            <>
              {reason && <p className="mt-2 text-sm text-tertiary">{reason}</p>}
              {snapshot?.officialGroups && snapshot.officialGroups.length > 0 ? (
                // Default rows are the group name, window, remaining share, and reset. The
                // provider's notes stay on the snapshot and open from this button: a tooltip
                // inside the peek would close it (task #258). Per-bucket sentences are not
                // painted; they repeat the reset already on the row.
                <div className="mt-3 space-y-4">
                  {snapshot.officialGroups.map((group, index) => (
                    <div key={`${group.name ?? "group"}-${index}`} className="space-y-3">
                      {group.name && (
                        <h4 className="text-sm font-medium break-words text-primary">
                          {group.name}
                        </h4>
                      )}
                      {group.buckets.map((bucket, bucketIndex) => {
                        const detail = officialBucketDetail(bucket);
                        return (
                          <UsageWindow
                            key={bucket.id ?? `${bucket.window ?? "bucket"}-${bucketIndex}`}
                            label={officialBucketLabel(bucket)}
                            window={{
                              // A remaining fraction wins, because that bucket's official number
                              // is the share left. A used percent stays a used percent.
                              ...officialMeter(bucket),
                              ...(bucket.status ? { status: bucket.status } : {}),
                              ...(bucket.resetsAt ? { resetsAt: bucket.resetsAt } : {}),
                            }}
                            detail={detail}
                            note={detail ? undefined : bucket.description}
                            creditUsage={
                              bucket.window === "credit" ? snapshot.creditUsage : undefined
                            }
                            timeZone={timeZone}
                          />
                        );
                      })}
                    </div>
                  ))}
                  {hasUsageNotes && (
                    <div>
                      <Button
                        size="sm"
                        color="link-gray"
                        aria-expanded={notesOpen}
                        aria-controls={notesId}
                        onPress={() => setNotesOpen((open) => !open)}
                      >
                        {notesOpen ? m.computer_usage_hide_notes() : m.computer_usage_notes()}
                      </Button>
                      {notesOpen && (
                        <div id={notesId} className="mt-2 space-y-2">
                          {snapshot.officialDescription && (
                            <p className="text-xs break-words text-tertiary">
                              {snapshot.officialDescription}
                            </p>
                          )}
                          {snapshot.officialGroups.map((group, index) =>
                            group.description ? (
                              <p
                                key={`${group.name ?? "note"}-${index}`}
                                className="text-xs break-words text-tertiary"
                              >
                                {group.name && (
                                  <span className="font-medium text-secondary">{group.name}. </span>
                                )}
                                {group.description}
                              </p>
                            ) : null,
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                windows.length > 0 && (
                  <div className="mt-3 space-y-3">
                    {windows.map(({ key, window }) => (
                      <UsageWindow
                        key={key}
                        label={usageWindowLabel(runtime.provider, key, window)}
                        window={window}
                        creditUsage={key === "primary" ? snapshot?.creditUsage : undefined}
                        timeZone={timeZone}
                      />
                    ))}
                  </div>
                )
              )}
            </>
          )}
        </section>
      )}

      {footer && <div className="px-4 py-3">{footer}</div>}
    </div>
  );
}

/** Percent the meter draws for one official bucket. A remaining fraction wins, because the
 * provider's bucket name is the remaining label (`Weekly Limit Remaining`). */
function officialMeter(bucket: { remainingFraction?: number; usedPercent?: number }): {
  usedPercent?: number;
} {
  if (bucket.remainingFraction === undefined) {
    return bucket.usedPercent !== undefined ? { usedPercent: bucket.usedPercent } : {};
  }
  const remaining = Math.min(1, Math.max(0, bucket.remainingFraction));
  return { usedPercent: Math.round(remaining * 10_000) / 100 };
}

function UsageWindow({
  label,
  window,
  creditUsage,
  detail,
  note,
  timeZone,
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
}) {
  // The header line is label + a short value + reset, kept on one line: a credit plan's amounts
  // ("7,517.29 / 10,000 credits used") would squeeze the label onto two lines in the popover, so
  // they move under the bar and the header shows the percentage, like a session window (task #109).
  const hydrated = useHydrated();
  const value =
    window.usedPercent !== undefined
      ? formatPercent(window.usedPercent)
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
              <RelativeTime value={window.resetsAt} timeZone={timeZone} plain />
            </>
          )}
        </p>
      </div>
      {window.usedPercent !== undefined && (
        // Untitled's own ProgressBarBase draws the bar (task #109); it takes no accessible name,
        // so the group around it carries the window's label for screen readers.
        <div role="group" aria-label={label} className="mt-1.5">
          <ProgressBarBase
            value={Math.min(100, Math.max(0, window.usedPercent))}
            className="h-1.5 rounded-full"
            progressClassName={cn(
              "rounded-full",
              window.status === "limit_reached" ? "bg-warning-solid" : "bg-brand-solid",
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

/** A window's share as a whole percentage ("76%"): the exact credit amounts, when there are
 * any, sit under the bar, so the header does not need decimals. */
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

/** A plan as a name: "pro" → "Pro"; a shouted "KIRO POWER" → "Kiro Power". */
function formatPlan(plan: string) {
  const words = plan === plan.toUpperCase() ? plan.toLowerCase() : plan;
  return words.replace(
    /(^|\s)(\p{L})/gu,
    (_, space: string, letter: string) => space + letter.toUpperCase(),
  );
}
