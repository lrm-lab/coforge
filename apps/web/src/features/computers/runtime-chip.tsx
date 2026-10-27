import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";

import { RuntimeProviderMark } from "#src/features/agents/runtime-provider-mark";
import { cn } from "#src/lib/utils";
import type { RuntimeStatus } from "./runtime-usage-status";

/**
 * One runtime on a Computer's detail: its mark, its name and one status dot, colored by the same
 * table as the popover's badge (`runtime-usage-status.ts`). A login state that needs saying comes
 * first, then the usage, then a plain sign-in; with none of them there is no dot. The account and
 * the usage sit in the popover the chip opens.
 */
export function RuntimeChip({
  runtime,
  status,
}: {
  runtime: { provider: RuntimeProvider; displayName: string };
  /** The popover's own status for the chip (`chipStatus`), so the two never disagree. */
  status?: RuntimeStatus;
}) {
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
