import { StatusDot } from "#src/components/ui/status-dot";
import { cx } from "#src/utils/cx";
import { computerIcon, type ComputerIdentity } from "./computer-identity";

export function ComputerStatusIcon({
  computer,
  online,
  className,
}: {
  computer: ComputerIdentity;
  online: boolean;
  className?: string;
}) {
  const Icon = computerIcon(computer);
  return (
    <span data-icon aria-hidden="true" className={cx("relative inline-flex shrink-0", className)}>
      <Icon className="size-full text-fg-tertiary" />
      <StatusDot
        tone={online ? "online" : "offline"}
        className="absolute -right-px -bottom-px size-1.5 ring-[1.5px] ring-bg-primary"
      />
    </span>
  );
}
