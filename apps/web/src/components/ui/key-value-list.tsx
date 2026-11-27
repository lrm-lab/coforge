import type { ReactNode } from "react";

import { cn } from "#src/lib/utils";

export type KeyValueLabelWidth = "compact" | "default" | "wide";
export type KeyValueSize = "sm" | "xs";

const LABEL_WIDTH_CLASSES: Record<KeyValueLabelWidth, string> = {
  compact: "grid-cols-[5rem_minmax(0,1fr)]",
  default: "grid-cols-[6.5rem_minmax(0,1fr)]",
  wide: "grid-cols-[7.5rem_minmax(0,1fr)] sm:grid-cols-[9.5rem_minmax(0,1fr)]",
};

const SIZE_CLASSES: Record<KeyValueSize, string> = {
  sm: "gap-x-4 gap-y-2.5 text-sm",
  xs: "gap-x-4 gap-y-1.5 text-xs",
};

export function KeyValueList({
  labelWidth = "default",
  size = "sm",
  className,
  children,
}: {
  labelWidth?: KeyValueLabelWidth;
  size?: KeyValueSize;
  className?: string;
  children: ReactNode;
}) {
  return (
    <dl
      className={cn(
        "grid items-baseline",
        LABEL_WIDTH_CLASSES[labelWidth],
        SIZE_CLASSES[size],
        className,
      )}
    >
      {children}
    </dl>
  );
}

export function KeyValueRow({
  label,
  children,
  mono = false,
  labelClassName,
  valueClassName,
}: {
  label: ReactNode;
  children: ReactNode;
  mono?: boolean;
  labelClassName?: string;
  valueClassName?: string;
}) {
  return (
    <>
      <dt className={cn("min-w-0 wrap-break-word text-tertiary", labelClassName)}>{label}</dt>
      <dd
        className={cn(
          "min-w-0 font-medium wrap-anywhere text-primary",
          mono && "font-mono",
          valueClassName,
        )}
      >
        {children}
      </dd>
    </>
  );
}
