import type { ComponentProps } from "react";
import { Cloud01 as Cloud, Monitor01 as Monitor } from "@untitledui/icons";
import { StatusDot } from "#src/components/ui/status-dot";
import { cx } from "#src/utils/cx";
import { computerKind, type ComputerIdentity } from "./computer-identity";

export function ComputerGlyph({
  kind,
  ...props
}: { kind: string } & ComponentProps<typeof Monitor>) {
  return computerKind(kind) === "cloud" ? <Cloud {...props} /> : <Monitor {...props} />;
}

export function ComputerStatusIcon({
  computer,
  online,
  className,
}: {
  computer: ComputerIdentity;
  online: boolean;
  className?: string;
}) {
  return (
    <span data-icon aria-hidden="true" className={cx("relative inline-flex shrink-0", className)}>
      <ComputerGlyph
        kind={computer.kind}
        className={cx("size-full", online ? "text-fg-tertiary" : "text-fg-quaternary")}
      />
      <StatusDot
        tone={online ? "online" : "offline"}
        className="absolute -right-px -bottom-px size-1.5 ring-[1.5px] ring-bg-primary"
      />
    </span>
  );
}

export function computerOptionClassName(online: boolean): string | undefined {
  return online ? undefined : "[&_[slot=label]]:text-quaternary";
}
