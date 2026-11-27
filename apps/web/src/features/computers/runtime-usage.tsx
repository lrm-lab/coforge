import { useState, type ReactNode } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Button as AriaButton, Dialog, DialogTrigger, Popover } from "react-aria-components";
import type { RuntimeAuthStatus } from "@lrm/coforge-anvil";

import {
  RUNTIME_PROVIDER_SUPPORTS_USAGE_SCAN,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { RuntimeProviderMark } from "#src/features/agents/runtime-provider-mark";
import { isSignableRuntimeProvider } from "./runtime-login-chip";
import { requestRuntimeAuthStatus } from "./runtime-auth.functions";
import { RuntimeResetCreditDialog } from "./runtime-reset-credit-action";
import { resetCreditPrompt } from "./runtime-reset-credit-state";
import { RuntimeUsagePopoverContent } from "./runtime-usage-popover-content";
import { useConsumeResetCredit } from "./use-reset-credit-consume";
import { useRuntimeUsage, type AgentUsageQueryScope } from "./use-runtime-usage";
import {
  chipStatus,
  shownAccount,
  usageHealth,
  usageReadForAuth,
  type AccountState,
  type RuntimeStatus,
} from "./runtime-usage-status";

export { RuntimeUsagePopoverContent };

export type Runtime = {
  provider: RuntimeProvider;
  version?: string;
  displayName: string;
};

function RuntimeIdentity({ runtime, health }: { runtime: Runtime; health?: RuntimeStatus }) {
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

export function UsageHealthDot({
  health,
  className,
}: {
  health?: RuntimeStatus;
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

export function RuntimeUsage({
  computerId,
  agentUsage,
  runtime,
  computerOnline,
  timeZone = null,
  trigger,
  triggerClassName,
  footer,
  footerLabel,
  actions,
  showUsage = true,
  canResetCredit = false,
  auth,
  account,
  accountAction,
  notice,
  codexCompatibleSupported,
}: {
  computerId: string;
  agentUsage?: AgentUsageQueryScope;
  runtime: Runtime;
  computerOnline?: boolean;
  timeZone?: string | null;
  trigger?: (status: RuntimeStatus | undefined) => ReactNode;
  triggerClassName?: string;
  footer?: ReactNode;
  footerLabel?: string;
  actions?: ReactNode;
  showUsage?: boolean;
  canResetCredit?: boolean;
  auth?: RuntimeAuthStatus;
  account?: AccountState;
  accountAction?: (shown: AccountState | undefined) => ReactNode;
  notice?: ReactNode;
  codexCompatibleSupported?: boolean;
}) {
  const [resetCreditDialog, setResetCreditDialog] = useState<
    | {
        computerId: string;
        provider: RuntimeProvider;
        available: number;
        accountLabel?: string;
      }
    | undefined
  >(undefined);
  const consumeResetCredit = useConsumeResetCredit();
  const supportsUsage = showUsage && RUNTIME_PROVIDER_SUPPORTS_USAGE_SCAN[runtime.provider];
  const usage = useRuntimeUsage(computerId, runtime.provider, {
    enabled: supportsUsage,
    computerOnline,
    signedIn: account === "logged_in",
    agent: agentUsage,
  });
  const requestStatus = useServerFn(requestRuntimeAuthStatus);
  const rereadLogin = () => {
    if (agentUsage || !isSignableRuntimeProvider(runtime.provider)) return;
    void requestStatus({ data: { computerId, provider: runtime.provider } }).catch(() => {});
  };

  const usageRead = usageReadForAuth(usage.data, account);
  const shown = shownAccount(account, usageRead);
  const health = supportsUsage ? usageHealth(usageRead) : undefined;
  const status = chipStatus(shown, health);
  const resolvedTrigger = trigger ? (
    trigger(status)
  ) : (
    <RuntimeIdentity runtime={runtime} health={health} />
  );

  if (!supportsUsage && !footer && !actions && !account && !notice) return resolvedTrigger;

  const snapshot = usageRead?.result?.snapshot;
  const resetPrompt =
    supportsUsage &&
    usage.data?.billing !== "provider-api-key" &&
    canResetCredit &&
    shown !== "logged_out"
      ? resetCreditPrompt(snapshot)
      : undefined;
  const openResetCredit = resetPrompt
    ? () => {
        const accountLabel = snapshot?.accountLabel ?? auth?.account?.maskedLabel;
        setResetCreditDialog({
          computerId,
          provider: runtime.provider,
          available: resetPrompt.available,
          ...(accountLabel ? { accountLabel } : {}),
        });
      }
    : undefined;
  const activeResetDialog =
    resetCreditDialog &&
    resetCreditDialog.computerId === computerId &&
    resetCreditDialog.provider === runtime.provider
      ? resetCreditDialog
      : undefined;

  const label = [
    runtime.displayName,
    supportsUsage && m.computer_usage_title(),
    status?.label,
    footerLabel,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <>
      <DialogTrigger onOpenChange={(open) => open && rereadLogin()}>
        <AriaButton
          aria-label={label}
          className={cn(
            "relative cursor-pointer any-pointer-coarse:after:absolute any-pointer-coarse:after:top-1/2 any-pointer-coarse:after:left-1/2 any-pointer-coarse:after:size-full any-pointer-coarse:after:min-h-11 any-pointer-coarse:after:min-w-11 any-pointer-coarse:after:-translate-x-1/2 any-pointer-coarse:after:-translate-y-1/2",
            triggerClassName ?? DEFAULT_TRIGGER_CLASS_NAME,
          )}
        >
          {resolvedTrigger}
        </AriaButton>
        <Popover
          placement="bottom start"
          offset={8}
          containerPadding={12}
          className="z-50 flex max-h-[calc(100dvh-4rem)] w-80 max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-xl border border-secondary bg-primary text-sm text-primary shadow-lg outline-none"
        >
          <Dialog aria-label={label} className="flex min-h-0 flex-col outline-none">
            {({ close }) => (
              <RuntimeUsagePopoverContent
                runtime={runtime}
                agentUsageUnavailable={usage.data?.unavailable}
                showUsage={supportsUsage}
                data={usageRead}
                scanning={usage.scanning}
                scanFailed={usage.scanFailed}
                computerOnline={computerOnline}
                timeZone={timeZone}
                onRefresh={usage.refresh}
                onClose={close}
                auth={auth}
                account={shown}
                footer={footer}
                actions={actions}
                accountAction={accountAction?.(shown)}
                resetPrompt={resetPrompt}
                onResetCredit={openResetCredit}
                notice={notice}
                billing={usage.data?.billing}
                codexCompatibleSupported={codexCompatibleSupported}
              />
            )}
          </Dialog>
        </Popover>
      </DialogTrigger>
      {activeResetDialog && (
        <RuntimeResetCreditDialog
          computerId={computerId}
          provider={runtime.provider}
          runtimeName={runtime.displayName}
          accountLabel={activeResetDialog.accountLabel}
          available={activeResetDialog.available}
          onConsume={(idempotencyKey) =>
            consumeResetCredit(computerId, runtime.provider, idempotencyKey, agentUsage)
          }
          onClose={() => setResetCreditDialog(undefined)}
        />
      )}
    </>
  );
}
