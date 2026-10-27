import { RefreshCw01 as RefreshCw, XClose } from "@untitledui/icons";
import { type ReactNode } from "react";
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
import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { RelativeTime } from "#src/components/ui/relative-time";
import { Skeleton } from "#src/components/ui/skeleton";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { RuntimeProviderMark } from "#src/features/agents/runtime-provider-mark";
import { useRuntimeUsage } from "./use-runtime-usage";
import { RuntimeUsageWindows } from "./runtime-usage-windows-list";
import {
  usageBadge,
  usageFailureDescription,
  usageHealth,
  usageReadForAuth,
  type UsageHealth,
} from "./runtime-usage-status";
import type { UsageReadResult } from "#src/server/centrifugo/usage-cache.server";

export type Runtime = {
  provider: RuntimeProvider;
  /** The CLI's own reported version, when known — e.g. absent for the Agent profile panel until
   * its Computer has reported one. */
  version?: string;
  displayName: string;
};

export type { UsageHealth } from "./runtime-usage-status";

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
  actions,
  showUsage = true,
  auth,
  accountAction,
}: {
  computerId: string;
  runtime: Runtime;
  /** `undefined` means "not known", treated like online for the purpose of auto-scanning. */
  computerOnline?: boolean;
  timeZone?: string | null;
  trigger?: (health: UsageHealth | undefined) => ReactNode;
  triggerClassName?: string;
  /** A band under the usage (the Agent profile's context). With a footer, a runtime that reports
   * no usage still opens a popover, holding only the footer. */
  footer?: ReactNode;
  /** Names what the footer holds in the trigger's accessible name. */
  footerLabel?: string;
  /** Bands held under everything else (the Computer page's Public switch and account): only the
   * usage between the header and them scrolls, so a short screen never hides an action. */
  actions?: ReactNode;
  /** False when the viewer may not see this runtime's account usage: the usage is neither read nor
   * drawn, and only the runtime band, the footer and the actions remain. */
  showUsage?: boolean;
  /** The runtime's login state on the Computer page, account fields only for those allowed them
   * (`runtimeAuthView`). With it, the popover opens even without usage, to show that account. */
  auth?: RuntimeAuthStatus;
  /** Signs the runtime in or out: drawn on the account band, signed in or not. */
  accountAction?: ReactNode;
}) {
  const supportsUsage = showUsage && RUNTIME_PROVIDER_SUPPORTS_USAGE_SCAN[runtime.provider];
  const usage = useRuntimeUsage(computerId, runtime.provider, {
    enabled: supportsUsage,
    computerOnline,
  });

  const usageRead = usageReadForAuth(usage.data, auth);
  const health = supportsUsage ? usageHealth(usageRead) : undefined;
  const resolvedTrigger = trigger ? (
    trigger(health)
  ) : (
    <RuntimeIdentity runtime={runtime} health={health} />
  );

  if (!supportsUsage && !footer && !actions && !auth) return resolvedTrigger;

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
        className="z-50 flex max-h-[calc(100dvh-4rem)] w-80 max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-xl border border-secondary bg-primary text-sm text-primary shadow-lg outline-none"
      >
        <Dialog aria-label={label} className="flex min-h-0 flex-col outline-none">
          {({ close }) => (
            <RuntimeUsagePopoverContent
              runtime={runtime}
              showUsage={supportsUsage}
              data={usageRead}
              scanning={usage.scanning}
              scanFailed={usage.scanFailed}
              computerOnline={computerOnline}
              timeZone={timeZone}
              onRefresh={usage.refresh}
              onClose={close}
              auth={auth}
              footer={footer}
              actions={actions}
              accountAction={accountAction}
            />
          )}
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}

/**
 * The popover's pure body: everything `RuntimeUsage` fetches, rendered without touching a query
 * client itself, so a test can render it directly with a plain `data` fixture. Bands split by
 * full-width rules, as on Raft: the runtime (name, login state, version, who sees the account),
 * its account (plan, status, usage windows), when it was read with Refresh, the caller's
 * `footer`, and last its `actions`, which stay in view while the bands above them scroll.
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
  actions,
  accountAction,
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
  actions?: ReactNode;
  accountAction?: ReactNode;
}) {
  const hydrated = useHydrated();
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
  // A signed-out runtime has no account to show: its band says so instead, beside Sign In.
  const signedOut = auth?.state === "logged_out";
  const planType = snapshot?.planType ?? auth?.account?.planLabel;
  const plan = planType ? formatPlan(planType) : undefined;
  const accountLabel = snapshot?.accountLabel ?? auth?.account?.maskedLabel;
  // Codex reports whether credits exist and whether they are unlimited. Its balance string is
  // not shown: Raft leaves it out, and with no credits it reads a bare "0".
  const credits = snapshot?.credits?.unlimited
    ? m.computer_usage_credits_unlimited()
    : snapshot?.credits?.hasCredits
      ? m.computer_usage_credits_available()
      : undefined;
  const accountNote = [plan && accountLabel, credits].filter(Boolean).join(" · ");
  const refreshLabel = scanning ? m.computer_usage_refreshing() : m.computer_usage_refresh();

  return (
    <div className="flex min-h-0 flex-col divide-y divide-secondary">
      {/* Everything but the caller's actions scrolls, so those stay in view on a short screen. */}
      <div className="min-h-0 divide-y divide-secondary overflow-y-auto">
        <div className="flex items-start gap-3 px-4 py-3">
          <div className="min-w-0 flex-1 space-y-1">
            <h2 className="truncate font-semibold text-primary">{runtime.displayName}</h2>
            {/* The version and when usage was read (task #109); RelativeTime is blank until
              hydration, and the separator waits with it. */}
            {(runtime.version || (showUsage && data?.result)) && (
              <p className="truncate text-xs text-tertiary">
                {runtime.version}
                {hydrated && showUsage && data?.result && (
                  <>
                    {runtime.version ? " · " : ""}
                    <RelativeTime value={data.result.collectedAt} timeZone={timeZone} plain />
                  </>
                )}
              </p>
            )}
            {auth && (
              <p className="text-xs text-tertiary">{m.computer_runtime_account_visibility()}</p>
            )}
            {signedOut && showUsage && (scanFailed || data?.result?.status === "error") && (
              <p role="alert" className="text-sm text-tertiary">
                {m.computer_usage_read_failed_retry()}
              </p>
            )}
          </div>
          {showUsage && (
            // `isLoading` (React Aria's `isPending`) keeps focus on the button mid-press, where
            // `isDisabled` would drop it (task #109). The tooltip repeats its name.
            <Tooltip title={refreshLabel}>
              <Button
                size="xs"
                color="tertiary"
                iconLeading={RefreshCw}
                aria-label={refreshLabel}
                isLoading={scanning}
                isDisabled={computerOnline === false}
                className="-mt-1 shrink-0"
                onPress={onRefresh}
              />
            </Tooltip>
          )}
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

        {signedOut && (
          <div className="flex items-center justify-between gap-3 bg-warning-primary px-4 py-3">
            <div className="min-w-0">
              <h3 className="text-sm font-medium text-warning-primary">
                {m.computer_runtime_auth_logged_out()}
              </h3>
              {/* Only beside the button that does it: a viewer who may not sign in gets no hint. */}
              {accountAction && (
                <p className="text-xs text-tertiary">
                  {m.computer_runtime_sign_in_hint({ runtime: runtime.displayName })}
                </p>
              )}
            </div>
            {accountAction}
          </div>
        )}

        {!signedOut && (showUsage || plan || accountLabel || accountAction) && (
          <section className="px-4 py-3">
            {/* The account band leads with the plan, then the signed-in account. A credits note
              counts too: Codex can report credits with no plan and no email, and that note used
              to show under the fallback heading. The empty "Runtime account" line is omitted
              only when the runtime names nothing and nothing is wrong. */}
            {(plan || accountLabel || accountNote || badge || accountAction) && (
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-medium text-primary">
                    {plan || accountLabel || m.computer_usage_account()}
                  </h3>
                  {accountNote && <p className="truncate text-xs text-tertiary">{accountNote}</p>}
                </div>
                {/* The sign-out button takes the badge's place: the usage below already shows a
                  limit or a failed read, and a badge beside it would name a state twice. */}
                {accountAction ??
                  (badge && (
                    <Badge color={badge.color} size="sm" className="shrink-0">
                      {badge.label}
                    </Badge>
                  ))}
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
                <RuntimeUsageWindows
                  provider={runtime.provider}
                  snapshot={snapshot}
                  timeZone={timeZone}
                />
              </>
            )}
          </section>
        )}
        {footer && <div className="px-4 py-3">{footer}</div>}
      </div>
      {actions && <div className="shrink-0 divide-y divide-secondary">{actions}</div>}
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
