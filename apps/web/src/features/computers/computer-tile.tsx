import { ProgressBar } from "react-aria-components";
import { ArrowUp } from "@untitledui/icons";
import { Spinner } from "#src/components/ui/spinner";

import { StatusDot } from "#src/components/ui/status-dot";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { computerIcon, type ComputerIdentity } from "./computer-identity";

/** The tile's pieces at its one size, 36px. */
const dims = {
  tile: "size-9",
  radius: "rounded-[10px]",
  icon: "size-4",
  dot: "size-2.5",
  dotBorder: "border-2",
  dotOffset: "-right-0.5 -bottom-0.5",
  badge: "size-4",
  badgeOffset: "-top-1 -right-1",
  badgeIcon: "size-[9px]",
  loading: "size-3",
} as const;

/** The Computer's own face: cloud-hosted or a machine the User controls. */
export function ComputerTile({
  computer,
  online,
  updateAvailableVersion,
  upgrading = false,
}: {
  computer: ComputerIdentity;
  /** Presence dot. Omit it where the panel already states the status. */
  online?: boolean;
  /** The release this Computer could move to. Omit it where nothing is waiting. */
  updateAvailableVersion?: string | null;
  /** An upgrade operation is in flight for this Computer. */
  upgrading?: boolean;
}) {
  const Icon = computerIcon(computer);

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
        <Icon className={dims.icon} />
      </span>
      {upgrading ? (
        <ProgressBar
          isIndeterminate
          aria-label={m.computer_upgrade_in_progress()}
          className={cn(
            "inline-flex shrink-0",
            "absolute text-fg-tertiary",
            dims.badgeOffset,
            dims.loading,
          )}
        >
          <Spinner className="size-full" />
        </ProgressBar>
      ) : (
        // A mark, not a control: the row around it opens the Computer, whose page offers the
        // upgrade to whoever may make it.
        updateAvailableVersion && (
          <span className={cn("absolute", dims.badgeOffset)}>
            <span
              aria-hidden="true"
              className={cn(
                "flex items-center justify-center rounded-full border-2 border-primary bg-fg-success-primary",
                dims.badge,
              )}
            >
              <ArrowUp className={cn(dims.badgeIcon, "text-white")} />
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
