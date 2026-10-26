import type { RuntimeAuthStatus } from "@lrm/coforge-anvil";
import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";

import { RuntimeProviderMark } from "#src/features/agents/runtime-provider-mark";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { UsageHealth } from "./runtime-usage";

/**
 * One runtime on a Computer's detail: its mark, its name and one status dot. The dot is
 * green when the runtime is signed in or its usage is fine, orange when it is signed out or its
 * usage needs attention, and absent when neither is known (a runtime with no login and no usage
 * reader). The account and the usage sit in the popover the chip opens.
 */
export function RuntimeChip({
  runtime,
  auth,
  health,
}: {
  runtime: { provider: RuntimeProvider; displayName: string };
  auth?: RuntimeAuthStatus;
  health?: UsageHealth;
}) {
  const status = runtimeStatus(auth, health);
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2 py-1 text-xs font-medium text-secondary ring-1 ring-secondary ring-inset hover:bg-primary_hover">
      <RuntimeProviderMark provider={runtime.provider} className="size-3.5" />
      {runtime.displayName}
      {status && (
        <span
          role="img"
          aria-label={status.label}
          className={cn(
            "size-2 shrink-0 rounded-full",
            status.ok ? "bg-success-solid" : "bg-warning-solid",
          )}
        />
      )}
    </span>
  );
}

function runtimeStatus(
  auth: RuntimeAuthStatus | undefined,
  health: UsageHealth | undefined,
): { ok: boolean; label: string } | undefined {
  if (auth?.state === "logged_out")
    return { ok: false, label: m.computer_runtime_auth_logged_out() };
  if (health === "attention") return { ok: false, label: m.computer_usage_health_attention() };
  if (health === "ok") return { ok: true, label: m.computer_usage_health_ok() };
  if (auth?.state === "logged_in") return { ok: true, label: m.computer_runtime_auth_logged_in() };
  return undefined;
}
