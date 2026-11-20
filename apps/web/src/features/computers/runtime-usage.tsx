import { type ReactNode } from "react";
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
import { RuntimeUsagePopoverContent } from "./runtime-usage-popover-content";
import { useRuntimeUsage, type AgentUsageQueryScope } from "./use-runtime-usage";
import {
  chipStatus,
  shownAccount,
  usageHealth,
  usageReadForAuth,
  type AccountState,
  type RuntimeStatus,
} from "./runtime-usage-status";
import type { UsageSnapshot } from "#src/server/centrifugo/usage-cache.server";

export { RuntimeUsagePopoverContent };

export type Runtime = {
  provider: RuntimeProvider;
  /** The CLI's own reported version, when known — e.g. absent for the Agent profile panel until
   * its Computer has reported one. */
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

/** A small health indicator for a Runtime trigger — reuses the same dot styling the Agent
 * profile panel already draws for a Computer's connected/offline state. */
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
  auth,
  account,
  accountAction,
  notice,
}: {
  computerId: string;
  agentUsage?: AgentUsageQueryScope;
  runtime: Runtime;
  /** `undefined` means "not known", treated like online for the purpose of auto-scanning. */
  computerOnline?: boolean;
  timeZone?: string | null;
  /** Receives the one status the chip draws: a login state that needs saying, else the usage. */
  trigger?: (status: RuntimeStatus | undefined) => ReactNode;
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
  /** The login state to name: `auth`'s, or `unreported` when the Computer is too old to send one. */
  account?: AccountState;
  /** Signs the runtime in or out for the login state the popover shows, if the viewer may, and
   * offers what its usage reading allows beside it (a reset credit). */
  accountAction?: (
    shown: AccountState | undefined,
    snapshot: UsageSnapshot | undefined,
  ) => ReactNode;
  /** A line under the version: why this runtime cannot be used, when it cannot. */
  notice?: ReactNode;
}) {
  const supportsUsage = showUsage && RUNTIME_PROVIDER_SUPPORTS_USAGE_SCAN[runtime.provider];
  const usage = useRuntimeUsage(computerId, runtime.provider, {
    enabled: supportsUsage,
    computerOnline,
    signedIn: account === "logged_in",
    agent: agentUsage,
  });
  // Opening the popover asks the Computer to read this runtime's login status again: it may have
  // been signed in or out on the Computer itself, which nothing else tells us. The Computer's
  // report reaches this page on the caller's channel, like any other.
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

  // A runtime that reports no usage still opens for its footer, an action, its login state, or the
  // reason it cannot be used at all.
  if (!supportsUsage && !footer && !actions && !account && !notice) return resolvedTrigger;

  // The dot is named here too: the trigger's aria-label replaces the dot's own name, a login
  // state first, as the chip draws it.
  const label = [
    runtime.displayName,
    supportsUsage && m.computer_usage_title(),
    status?.label,
    footerLabel,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <DialogTrigger onOpenChange={(open) => open && rereadLogin()}>
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
              accountAction={accountAction?.(shown, usageRead?.result?.snapshot)}
              notice={notice}
            />
          )}
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
