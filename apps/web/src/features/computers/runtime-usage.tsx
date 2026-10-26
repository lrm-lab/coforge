import { RefreshCw01 as RefreshCw, XClose } from "@untitledui/icons";
import { useId, useState, type ReactNode } from "react";
import { useHydrated } from "@tanstack/react-router";
import { Button as AriaButton, Dialog, DialogTrigger, Popover } from "react-aria-components";
import type { RuntimeAuthStatus } from "@lrm/coforge-anvil";

import {
  RUNTIME_PROVIDER_SUPPORTS_USAGE_SCAN,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Skeleton } from "#src/components/ui/skeleton";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { RuntimeProviderMark } from "#src/features/agents/runtime-provider-mark";
import { useRuntimeUsage } from "./use-runtime-usage";
import {
  officialBucketDetail,
  officialBucketLabel,
  usageWindowLabel,
} from "./runtime-usage-windows";
import { TimeMessage, UsageWindow } from "./usage-window";
import type { UsageReadResult, UsageResultRecord } from "#src/server/centrifugo/usage-cache.server";

export type Runtime = {
  provider: RuntimeProvider;
  /** The CLI's own reported version, when known — e.g. absent for the Agent profile panel until
   * its Computer has reported one. */
  version?: string;
  displayName: string;
};

/** `ok` only when the last read is fresh, available, and no usage window is at its limit; `label`
 * is the popover badge's own word for it, so the dot and the badge never name it differently. */
export type UsageHealth = { ok: boolean; label: string };

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
      aria-label={health.label}
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        health.ok ? "bg-success-solid" : "bg-warning-solid",
        className,
      )}
    />
  );
}

const DEFAULT_TRIGGER_CLASS_NAME =
  "-m-1 min-w-0 rounded-lg p-1 text-left outline-none hover:bg-primary_hover data-focus-visible:ring-2 data-focus-visible:ring-brand";

/**
 * One Code Agent runtime on a Computer, and the shared provider-usage popover, opened on a press
 * with a close button as on Raft (this replaces the hover peek task #116 chose): reads the cached
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
  footerLabel,
  showUsage = true,
  auth,
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
  /** Names what the footer holds in the trigger's accessible name. */
  footerLabel?: string;
  /** False when the viewer may not see this runtime's account usage: the usage is neither read nor
   * drawn, and only the runtime band and the footer remain. */
  showUsage?: boolean;
  /** The runtime's login state on the Computer page, account fields only for those allowed them
   * (`runtimeAuthView`). With it, the popover opens even without usage, to show that account. */
  auth?: RuntimeAuthStatus;
}) {
  const supportsUsage = showUsage && RUNTIME_PROVIDER_SUPPORTS_USAGE_SCAN[runtime.provider];
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

  if (!supportsUsage && !footer && !auth) return resolvedTrigger;

  // The health is named here too: the trigger's aria-label replaces the health dot's own name.
  const label = supportsUsage
    ? [runtime.displayName, m.computer_usage_title(), health?.label, footerLabel]
        .filter(Boolean)
        .join(" · ")
    : [runtime.displayName, footerLabel].filter(Boolean).join(" · ");

  return (
    <DialogTrigger>
      <AriaButton aria-label={label} className={triggerClassName ?? DEFAULT_TRIGGER_CLASS_NAME}>
        {resolvedTrigger}
      </AriaButton>
      <Popover
        placement="bottom start"
        offset={8}
        containerPadding={12}
        className="z-50 max-h-[calc(100dvh-4rem)] w-80 max-w-[calc(100vw-24px)] overflow-y-auto rounded-xl border border-secondary bg-primary text-sm text-primary shadow-lg outline-none"
      >
        <Dialog aria-label={label} className="outline-none">
          {({ close }) => (
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
              auth={auth}
              footer={footer}
            />
          )}
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}

function usageHealth(data: UsageReadResult | undefined): UsageHealth | undefined {
  if (!data?.result) return undefined;
  const badge = usageBadge(data.result);
  if (!badge) return undefined;
  if (badge.color !== "success") return { ok: false, label: badge.label };
  return data.state === "fresh"
    ? { ok: true, label: m.computer_usage_health_ok() }
    : { ok: false, label: m.computer_usage_health_attention() };
}

const USAGE_READER_NOT_CONNECTED = "Usage reader is not connected yet";

function usageBadge(
  result: UsageResultRecord,
): { color: "success" | "warning" | "error"; label: string } | undefined {
  if (result.status === "reauth")
    return { color: "warning", label: m.computer_runtime_auth_logged_out() };
  if (result.status === "unavailable")
    return { color: "warning", label: m.computer_usage_read_error() };
  if (result.status === "error") return { color: "error", label: m.computer_usage_read_error() };
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
  if (status === "unavailable" || status === "error") return m.computer_usage_read_failed_retry();
  if (status === "unsupported")
    return result?.message === USAGE_READER_NOT_CONNECTED
      ? m.computer_usage_not_connected()
      : m.computer_usage_status_unsupported();
  return undefined;
}

/**
 * The popover's pure body: everything `RuntimeUsage` fetches, rendered without touching a query
 * client itself, so a test can render it directly with a plain `data` fixture. Bands split by
 * full-width rules, as on Raft: the runtime (name, login state, version, who sees the account),
 * its account (plan, status, usage windows), when it was read with Refresh, and the caller's
 * `footer`.
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
  auth,
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
  auth?: RuntimeAuthStatus;
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
        ? m.computer_usage_read_failed_retry()
        : usageFailureDescription(data?.result);
  const reading =
    !reason && (!data || (data.state === "missing" && (scanning || data.pendingScanId)));
  // A signed-out runtime has no account to show; its state leads the popover instead.
  const signedOut = auth?.state === "logged_out";
  const planType = snapshot?.planType ?? auth?.account?.planLabel;
  const plan = planType ? formatPlan(planType) : undefined;
  const accountLabel = snapshot?.accountLabel ?? auth?.account?.maskedLabel;
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
      <div className="flex items-start gap-3 px-4 py-3">
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="truncate font-semibold text-primary">{runtime.displayName}</h2>
          {signedOut && (
            <Badge color="warning" size="sm">
              {m.computer_runtime_auth_logged_out()}
            </Badge>
          )}
          {runtime.version && (
            <p className="truncate text-xs text-tertiary">
              {m.computer_runtime_version({ version: runtime.version })}
            </p>
          )}
          {auth && (
            <p className="text-xs text-tertiary">{m.computer_runtime_account_visibility()}</p>
          )}
        </div>
        {onClose && (
          <ButtonUtility
            icon={XClose}
            size="xs"
            color="tertiary"
            tooltip={m.controls_close()}
            className="-mt-1 -mr-1.5 shrink-0"
            onClick={onClose}
          />
        )}
      </div>

      {((showUsage && !signedOut) || (!signedOut && (plan || accountLabel))) && (
        <section className="px-4 py-3">
          {/* The account band leads with the plan, then the signed-in account. A credits note
              counts too: Codex can report credits with no plan and no email, and that note used
              to show under the fallback heading. The empty "Runtime account" line is omitted
              only when the runtime names nothing and nothing is wrong. */}
          {(plan || accountLabel || accountNote || badge) && (
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-medium text-primary">
                  {plan || accountLabel || m.computer_usage_account()}
                </h3>
                {accountNote && <p className="truncate text-xs text-tertiary">{accountNote}</p>}
              </div>
              {badge && (
                <Badge color={badge.color} size="sm" className="shrink-0">
                  {badge.label}
                </Badge>
              )}
            </div>
          )}
          {!showUsage ? null : reading ? (
            <div aria-label={m.computer_usage_reading()} className="mt-3 space-y-3">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          ) : (
            <>
              {reason && <p className="mt-2 text-sm text-tertiary">{reason}</p>}
              {snapshot?.officialGroups && snapshot.officialGroups.length > 0 ? (
                // Default rows are the group name, window, used share, and reset. The
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
                              ...(bucket.usedPercent !== undefined
                                ? { usedPercent: bucket.usedPercent }
                                : {}),
                              ...(bucket.status ? { status: bucket.status } : {}),
                              ...(bucket.resetsAt ? { resetsAt: bucket.resetsAt } : {}),
                            }}
                            detail={detail}
                            note={detail ? undefined : bucket.description}
                            creditUsage={
                              bucket.window === "credit" ? snapshot.creditUsage : undefined
                            }
                            timeZone={timeZone}
                            showLeft
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
                        showLeft
                      />
                    ))}
                  </div>
                )
              )}
            </>
          )}
        </section>
      )}

      {showUsage && !signedOut && (
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          {/* RelativeTime is blank until hydration, so the line waits with it. */}
          <p className="min-w-0 truncate text-xs text-tertiary">
            {hydrated && data?.result && (
              <TimeMessage
                message={(time) => m.computer_usage_updated({ time })}
                value={data.result.collectedAt}
                timeZone={timeZone}
              />
            )}
          </p>
          {/* `isLoading` is React Aria's `isPending`: the button ignores presses but keeps focus,
              where `isDisabled` would drop it to the page mid-press (task #109). */}
          <Button
            size="sm"
            color="secondary"
            iconLeading={RefreshCw}
            isLoading={scanning}
            showTextWhileLoading
            isDisabled={computerOnline === false}
            className="shrink-0"
            onPress={onRefresh}
          >
            {scanning ? m.computer_usage_refreshing() : m.computer_usage_refresh()}
          </Button>
        </div>
      )}

      {footer && <div className="px-4 py-3">{footer}</div>}
    </div>
  );
}

/** A plan as a name: "pro" → "Pro"; a shouted "KIRO POWER" → "Kiro Power". */
function formatPlan(plan: string) {
  const words = plan === plan.toUpperCase() ? plan.toLowerCase() : plan;
  return words.replace(
    /(^|\s)(\p{L})/gu,
    (_, space: string, letter: string) => space + letter.toUpperCase(),
  );
}
