import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";

import { RuntimeProviderMark } from "#src/features/agents/runtime-provider-mark";
import { cn } from "#src/lib/utils";
import type { RuntimeStatus } from "./runtime-usage-status";

export function RuntimeChip({
  runtime,
  status,
}: {
  runtime: { provider: RuntimeProvider; displayName: string };
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
