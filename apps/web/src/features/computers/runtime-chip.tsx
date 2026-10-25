import type { RuntimeAuthStatus } from "@lrm/coforge-anvil";
import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";
import { Globe01 } from "@untitledui/icons";

import { RuntimeProviderMark } from "#src/features/agents/runtime-provider-mark";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { UsageHealthDot, type UsageHealth } from "./runtime-usage";

/**
 * One runtime on a Computer's detail: its mark and name, its login status when the Computer
 * reported one, whether it is public, and its usage health. A viewer who may not see the account
 * gets a status without one, so the chip shows only the state.
 */
export function RuntimeChip({
  runtime,
  auth,
  health,
  isPublic = false,
}: {
  runtime: { provider: RuntimeProvider; displayName: string };
  auth?: RuntimeAuthStatus;
  health?: UsageHealth;
  isPublic?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-secondary bg-primary py-1 pr-2.5 pl-1.5 text-xs font-medium text-secondary hover:bg-primary_hover">
      <RuntimeProviderMark provider={runtime.provider} className="size-4" />
      {runtime.displayName}
      {auth && <RuntimeAuthText auth={auth} />}
      {isPublic && (
        <Globe01
          role="img"
          aria-label={m.computer_runtime_public()}
          className="size-3.5 text-fg-brand-secondary"
        />
      )}
      <UsageHealthDot health={health} />
    </span>
  );
}

function RuntimeAuthText({ auth }: { auth: RuntimeAuthStatus }) {
  const parts =
    auth.state === "logged_in"
      ? [m.computer_runtime_auth_logged_in(), auth.account?.maskedLabel, auth.account?.planLabel]
      : [authStateLabel(auth)];
  return (
    <span
      className={cn(
        "border-l border-secondary pl-1.5 font-normal",
        auth.state === "logged_out" ? "text-warning-primary" : "text-tertiary",
      )}
    >
      {parts.filter(Boolean).join(" · ")}
    </span>
  );
}

function authStateLabel(auth: RuntimeAuthStatus): string {
  if (auth.state === "logged_out") return m.computer_runtime_auth_logged_out();
  if (auth.state !== "unavailable") return m.computer_runtime_auth_unknown();
  switch (auth.unavailableReason) {
    case "not_installed":
      return m.computer_runtime_auth_not_installed();
    case "version_unsupported":
      return m.computer_runtime_auth_version_unsupported();
    case "unsupported_installation":
      return m.computer_runtime_auth_unsupported_installation();
    default:
      return m.computer_runtime_auth_unknown();
  }
}
