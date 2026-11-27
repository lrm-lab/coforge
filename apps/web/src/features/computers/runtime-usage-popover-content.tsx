import { RefreshCw01 as RefreshCw, XClose } from "@untitledui/icons";
import { type ReactNode } from "react";
import { useHydrated } from "@tanstack/react-router";
import type { RuntimeAuthStatus } from "@lrm/coforge-anvil";

import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { RelativeTime } from "#src/components/ui/relative-time";
import { Skeleton } from "#src/components/ui/skeleton";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { Runtime } from "./runtime-usage";
import { RuntimeResetCreditAction } from "./runtime-reset-credit-action";
import type { ResetCreditPrompt } from "./runtime-reset-credit-state";
import { RuntimeUsageWindows } from "./runtime-usage-windows-list";
import {
  accountBand,
  usageFailureDescription,
  usageStatus,
  type AccountState,
} from "./runtime-usage-status";
import type { UsageReadResult } from "#src/server/centrifugo/usage-cache.server";

export function RuntimeUsagePopoverContent({
  runtime,
  showUsage = true,
  data,
  scanning,
  scanFailed = false,
  agentUsageUnavailable,
  computerOnline,
  timeZone = null,
  onRefresh,
  onClose,
  auth,
  account,
  footer,
  actions,
  accountAction,
  resetPrompt,
  onResetCredit,
  notice,
}: {
  runtime: Pick<Runtime, "provider" | "displayName" | "version">;
  showUsage?: boolean;
  data?: UsageReadResult;
  scanning: boolean;
  scanFailed?: boolean;
  agentUsageUnavailable?: boolean;
  computerOnline?: boolean;
  timeZone?: string | null;
  onRefresh: () => void;
  onClose?: () => void;
  auth?: RuntimeAuthStatus;
  account?: AccountState;
  footer?: ReactNode;
  actions?: ReactNode;
  accountAction?: ReactNode;
  resetPrompt?: ResetCreditPrompt;
  onResetCredit?: () => void;
  notice?: ReactNode;
}) {
  const hydrated = useHydrated();
  const snapshot = data?.result?.snapshot;
  const badge = data?.result ? usageStatus(data.result) : undefined;
  const reason =
    computerOnline === false
      ? m.computer_usage_offline()
      : scanFailed
        ? m.computer_usage_read_failed_retry()
        : agentUsageUnavailable
          ? m.computer_agent_usage_unavailable()
          : usageFailureDescription(data?.result);
  const reading =
    !reason && (!data || (data.state === "missing" && (scanning || data.pendingScanId)));
  const signedOut = account === "logged_out";
  const warnedAccount = accountBand(account);
  const sectionAction = warnedAccount ? undefined : accountAction;
  const planType = snapshot?.planType ?? auth?.account?.planLabel;
  const plan = planType ? formatPlan(planType) : undefined;
  const accountLabel = snapshot?.accountLabel ?? auth?.account?.maskedLabel;
  const usageCredits = snapshot?.credits;
  const balance = runtime.provider === RUNTIME_PROVIDER.CODEX ? usageCredits?.balance : undefined;
  const credits = usageCredits?.unlimited
    ? m.computer_usage_credits_unlimited()
    : balance
      ? m.computer_usage_credits_balance({ balance })
      : usageCredits?.hasCredits
        ? m.computer_usage_credits_available()
        : undefined;
  const resetCredits =
    runtime.provider === RUNTIME_PROVIDER.CODEX ? snapshot?.resetCreditsAvailable : undefined;
  const resetsFact =
    resetCredits !== undefined && !resetPrompt
      ? resetCredits > 0
        ? m.runtime_reset_credit_left({ count: resetCredits })
        : m.runtime_reset_credit_none()
      : undefined;
  const facts = [resetsFact, credits].filter((fact): fact is NonNullable<typeof fact> =>
    Boolean(fact),
  );
  const accountNote = plan && accountLabel ? accountLabel : undefined;
  const title = plan || accountLabel;
  const refreshLabel = scanning ? m.computer_usage_refreshing() : m.computer_usage_refresh();

  return (
    <div className="flex min-h-0 flex-col divide-y divide-secondary">
      <div className="min-h-0 divide-y divide-secondary overflow-y-auto">
        <div className="flex items-start gap-3 px-4 py-3">
          <div className="min-w-0 flex-1 space-y-1">
            <h2 dir="auto" className="font-semibold wrap-anywhere text-primary">
              {runtime.displayName}
            </h2>
            {(runtime.version || (showUsage && data?.result)) && (
              <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-tertiary">
                {runtime.version && (
                  <span dir="ltr" className="wrap-anywhere">
                    {runtime.version}
                  </span>
                )}
                {hydrated && showUsage && data?.result && (
                  <span>
                    <RelativeTime value={data.result.collectedAt} timeZone={timeZone} plain />
                  </span>
                )}
              </p>
            )}
            {notice && <p className="text-sm wrap-anywhere text-tertiary">{notice}</p>}
            {auth && (
              <p className="text-xs text-tertiary">{m.computer_runtime_account_visibility()}</p>
            )}
            {signedOut && showUsage && scanFailed && (
              <p role="alert" className="text-sm text-tertiary">
                {m.computer_usage_read_failed_retry()}
              </p>
            )}
          </div>
          {(showUsage || notice) && (
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
              className="-mt-1 -me-1.5 shrink-0"
              onClick={onClose}
            />
          )}
        </div>

        {warnedAccount && (
          <div className="flex items-center justify-between gap-3 bg-warning-primary px-4 py-3">
            <div className="min-w-0">
              <h3 className="text-sm font-medium text-warning-primary">{warnedAccount.label}</h3>
              {signedOut && accountAction && (
                <p className="text-xs text-tertiary">
                  {m.computer_runtime_sign_in_hint({ runtime: runtime.displayName })}
                </p>
              )}
            </div>
            {accountAction}
          </div>
        )}

        {!signedOut && (showUsage || plan || accountLabel || sectionAction) && (
          <section className="px-4 py-3">
            {(title || accountNote || badge || sectionAction) && (
              <div className="flex items-center justify-between gap-3">
                {(title || accountNote) && (
                  <div className="min-w-0">
                    {title && (
                      <h3 className="line-clamp-2 text-sm font-medium wrap-anywhere text-primary">
                        {title}
                      </h3>
                    )}
                    {accountNote && (
                      <p className="line-clamp-2 text-xs wrap-anywhere text-tertiary">
                        {accountNote}
                      </p>
                    )}
                  </div>
                )}
                {sectionAction ??
                  (badge && (
                    <Badge
                      color={badge.ok ? "success" : "warning"}
                      size="sm"
                      className="ms-auto shrink-0"
                    >
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
                {facts.length > 0 && (
                  <p
                    className={cn(
                      "mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs tabular-nums text-tertiary",
                      balance && "wrap-anywhere",
                    )}
                  >
                    {facts.map((fact) => (
                      <span key={fact} className={balance ? undefined : "truncate"}>
                        {fact}
                      </span>
                    ))}
                  </p>
                )}
              </>
            )}
          </section>
        )}
        {!signedOut && showUsage && !reading && resetPrompt && onResetCredit && (
          <RuntimeResetCreditAction
            prompt={resetPrompt}
            runtimeName={runtime.displayName}
            computerOnline={computerOnline}
            onPress={onResetCredit}
          />
        )}
        {footer && <div className="px-4 py-3">{footer}</div>}
      </div>
      {actions && <div className="shrink-0 divide-y divide-secondary">{actions}</div>}
    </div>
  );
}

function formatPlan(plan: string) {
  const normalized = plan.replace(/[_-]+/g, " ").trim();
  const words = normalized === normalized.toUpperCase() ? normalized.toLowerCase() : normalized;
  return words.replace(
    /(^|\s)(\p{L})/gu,
    (_, space: string, letter: string) => space + letter.toUpperCase(),
  );
}
