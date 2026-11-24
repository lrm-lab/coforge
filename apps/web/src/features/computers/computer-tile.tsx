import { AlertCircle, ArrowUp } from "@untitledui/icons";

import { StatusDot } from "#src/components/ui/status-dot";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { ComputerIdentity } from "./computer-identity";
import { ComputerGlyph } from "./computer-status-icon";

const dims = {
  tile: "size-9",
  radius: "rounded-lg",
  icon: "size-4",
  dot: "size-2.5",
  dotBorder: "border-2",
  dotOffset: "-end-0.5 -bottom-0.5",
  badge: "size-4",
  badgeOffset: "-top-1 -end-1",
  badgeIcon: "size-2.5",
} as const;

export function ComputerTile({
  computer,
  online,
  updateAvailableVersion,
  upgrading = false,
  upgradeFailed = false,
}: {
  computer: ComputerIdentity;
  online?: boolean;
  updateAvailableVersion?: string | null;
  upgrading?: boolean;
  upgradeFailed?: boolean;
}) {
  return (
    <span className="relative flex shrink-0">
      <span
        aria-hidden="true"
        className={cn(
          "flex items-center justify-center border border-secondary bg-primary text-tertiary",
          dims.tile,
          dims.radius,
        )}
      >
        <ComputerGlyph kind={computer.kind} className={dims.icon} />
      </span>
      {upgrading ? null : upgradeFailed ? (
        <span className={cn("absolute", dims.badgeOffset)}>
          <span
            aria-hidden="true"
            className={cn(
              "flex items-center justify-center rounded-full border-2 border-primary bg-error-solid",
              dims.badge,
            )}
          >
            <AlertCircle className={cn(dims.badgeIcon, "text-fg-white")} />
          </span>
          <span className="sr-only">{m.computer_upgrade_failed_title_generic()}</span>
        </span>
      ) : (
        updateAvailableVersion && (
          <span className={cn("absolute", dims.badgeOffset)}>
            <span
              aria-hidden="true"
              className={cn(
                "flex items-center justify-center rounded-full border-2 border-primary bg-fg-success-primary",
                dims.badge,
              )}
            >
              <ArrowUp className={cn(dims.badgeIcon, "text-fg-white")} />
            </span>
            <span className="sr-only">
              {m.computer_new_version({ version: updateAvailableVersion })}
            </span>
          </span>
        )
      )}
      {online !== undefined && (
        <StatusDot
          tone={online ? "online" : "offline"}
          label={online ? m.computer_status_online() : m.computer_status_offline()}
          className={cn("absolute border-primary", dims.dot, dims.dotBorder, dims.dotOffset)}
        />
      )}
    </span>
  );
}
