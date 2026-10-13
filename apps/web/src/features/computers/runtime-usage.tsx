import { RefreshCw01 as RefreshCw, XClose } from "@untitledui/icons";
import {
  Button as AriaButton,
  Dialog as AriaDialog,
  DialogTrigger as AriaDialogTrigger,
  Popover as AriaPopover,
} from "react-aria-components";
import type { ReactNode } from "react";

import {
  RUNTIME_PROVIDER_SUPPORTS_USAGE_SCAN,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { ProgressBarBase } from "#src/components/base/progress-indicators/progress-indicators";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Skeleton } from "#src/components/ui/skeleton";
import { HoverPopover } from "#src/components/ui/hover-popover";
import { RelativeTime } from "#src/components/ui/relative-time";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { RuntimeProviderMark } from "#src/features/agents/runtime-provider-mark";
import { useRuntimeUsage } from "./use-runtime-usage";
import { usageWindowLabel } from "./runtime-usage-windows";
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

export function RuntimeIdentity({ runtime, health }: { runtime: Runtime; health?: UsageHealth }) {
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
  openOnPress = false,
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
  /** Open on a press, with a close button, instead of peeking on hover: for a popover holding
   * controls the pointer must reach without the popover closing under it. */
  openOnPress?: boolean;
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

  const content = (close?: () => void) => (
    <RuntimeUsagePopoverContent
      runtime={runtime}
      showUsage={supportsUsage}
      data={usage.data}
      scanning={usage.scanning}
      scanFailed={usage.scanFailed}
      computerOnline={computerOnline}
      timeZone={timeZone}
      onRefresh={usage.refresh}
      onClose={close}
      footer={footer}
    />
  );
  const label = supportsUsage
    ? `${runtime.displayName} · ${m.computer_usage_title()}`
    : runtime.displayName;

  if (openOnPress)
    return (
      <AriaDialogTrigger>
        <AriaButton aria-label={label} className={triggerClassName ?? DEFAULT_TRIGGER_CLASS_NAME}>
          {resolvedTrigger}
        </AriaButton>
        <AriaPopover
          placement="bottom start"
          offset={8}
          containerPadding={12}
          className={cn(
            "z-50 w-80 max-w-[calc(100vw-1.5rem)] origin-(--trigger-anchor-point) overflow-hidden rounded-xl border border-secondary bg-primary text-sm text-primary shadow-lg outline-none",
            "motion-safe:data-[entering]:animate-in motion-safe:data-[entering]:fade-in motion-safe:data-[exiting]:animate-out motion-safe:data-[exiting]:fade-out",
          )}
        >
          <AriaDialog aria-label={label} className="outline-hidden">
            {({ close }) => content(close)}
          </AriaDialog>
        </AriaPopover>
      </AriaDialogTrigger>
    );

  return (
    <HoverPopover
      label={label}
      trigger={resolvedTrigger}
      triggerClassName={triggerClassName ?? DEFAULT_TRIGGER_CLASS_NAME}
      className="text-sm"
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

function usageBadge(
  result: UsageResultRecord,
): { color: "success" | "warning" | "error"; label: string } | undefined {
  if (result.status === "reauth")
    return { color: "warning", label: m.computer_usage_badge_reauth() };
  if (result.status === "unavailable")
    return { color: "error", label: m.computer_usage_badge_unavailable() };
  if (result.status === "error") return { color: "error", label: m.computer_usage_badge_error() };
  if (result.status === "unsupported")
    return { color: "warning", label: m.computer_usage_badge_unsupported() };
  const rateLimited =
    result.snapshot?.health === "rate_limited" ||
    result.snapshot?.primary?.status === "limit_reached" ||
    result.snapshot?.secondary?.status === "limit_reached";
  return rateLimited
    ? { color: "warning", label: m.computer_usage_limit_reached() }
    : { color: "success", label: m.computer_usage_badge_ok() };
}

function usageFailureDescription(status: UsageResultRecord["status"] | undefined) {
  if (status === "reauth") return m.computer_usage_reauth();
  if (status === "unavailable") return m.computer_usage_unavailable_description();
  if (status === "error") return m.computer_usage_error();
  if (status === "unsupported") return m.computer_usage_status_unsupported();
  return undefined;
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
  onClose,
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
  onClose?: () => void;
  footer?: ReactNode;
}) {
  const snapshot = data?.result?.snapshot;
  const badge = data?.result ? usageBadge(data.result) : undefined;
  const reason =
    computerOnline === false
      ? m.computer_usage_offline()
      : scanFailed
        ? m.computer_usage_no_response()
        : usageFailureDescription(data?.result?.status);
  const reading =
    !reason && (!data || (data.state === "missing" && (scanning || data.pendingScanId)));
  const account = [snapshot?.planType && formatPlan(snapshot.planType), snapshot?.accountLabel]
    .filter(Boolean)
    .join(" · ");
  const windows = snapshot
    ? (["primary", "secondary"] as const).flatMap((key) => {
        const window = snapshot[key];
        return window ? [{ key, window }] : [];
      })
    : [];

  return (
    <div className="divide-y divide-secondary">
      <div className="flex items-start gap-3 px-4 py-3">
        <RuntimeProviderMark provider={runtime.provider} className="mt-0.5 size-6 shrink-0" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold text-primary">{runtime.displayName}</h2>
          <div className="flex min-w-0 items-center justify-between gap-2">
            <p className="truncate text-xs text-tertiary">
              {runtime.version}
              {showUsage && data?.result && (
                <>
                  {runtime.version ? " · " : ""}
                  <RelativeTime value={data.result.collectedAt} timeZone={timeZone} />
                </>
              )}
            </p>
            {showUsage && (
              <Button
                size="xs"
                color="link-gray"
                iconLeading={RefreshCw}
                isLoading={scanning}
                showTextWhileLoading
                isDisabled={scanning || computerOnline === false}
                className="shrink-0"
                onPress={onRefresh}
              >
                {scanning ? m.computer_usage_refreshing() : m.computer_usage_refresh()}
              </Button>
            )}
          </div>
        </div>
        {onClose && (
          <ButtonUtility
            size="xs"
            color="tertiary"
            icon={XClose}
            aria-label={m.controls_close()}
            className="-mt-1 -mr-1 shrink-0"
            onClick={onClose}
          />
        )}
      </div>

      {showUsage && (
        <section className="px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="font-medium text-primary">{m.computer_usage_account()}</h3>
              {account && <p className="mt-0.5 truncate text-xs text-tertiary">{account}</p>}
            </div>
            {badge && (
              <Badge color={badge.color} size="sm" className="shrink-0">
                {badge.label}
              </Badge>
            )}
          </div>
          {reading ? (
            <div aria-label={m.computer_usage_reading()} className="mt-3 space-y-3">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          ) : (
            <>
              {reason && <p className="mt-2 text-sm text-tertiary">{reason}</p>}
              {windows.length > 0 && (
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
              )}
            </>
          )}
        </section>
      )}

      {footer && <div className="px-4 py-3">{footer}</div>}
    </div>
  );
}

function UsageWindow({
  label,
  window,
  creditUsage,
  timeZone,
}: {
  label: string;
  window: NonNullable<NonNullable<UsageResultRecord["snapshot"]>["primary"]>;
  creditUsage?: NonNullable<UsageResultRecord["snapshot"]>["creditUsage"];
  timeZone: string | null;
}) {
  // The header line is label + a short value + reset, kept on one line: a credit plan's amounts
  // ("7,517.29 / 10,000 credits used") would squeeze the label onto two lines in the popover, so
  // they move under the bar and the header shows the percentage, like a session window (task #109).
  const value =
    window.usedPercent !== undefined
      ? `${window.usedPercent}%`
      : creditUsage
        ? creditAmounts(creditUsage)
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
          {window.resetsAt !== undefined && (
            <>
              {" · "}
              <RelativeTime value={window.resetsAt} timeZone={timeZone} />
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
    </div>
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

function formatPlan(plan: string) {
  return plan ? `${plan[0]!.toUpperCase()}${plan.slice(1)}` : plan;
}
