import type { FC, ReactNode } from "react";

import { cx } from "#src/utils/cx";

export type ListIconTileTone = "default" | "brand" | "destructive";

const TONE_CLASS: Record<ListIconTileTone, string> = {
  default: "text-fg-secondary",
  brand: "text-brand-secondary",
  destructive: "text-error-primary",
};

export function ListIconTile({
  icon: Icon,
  children,
  tone = "default",
  className,
}: {
  icon?: FC<{ className?: string }>;
  children?: ReactNode;
  tone?: ListIconTileTone;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "inline-flex size-[1.875rem] shrink-0 items-center justify-center rounded-lg bg-secondary ring-1 ring-secondary_alt ring-inset",
        TONE_CLASS[tone],
        className,
      )}
    >
      {Icon ? <Icon aria-hidden="true" className="size-4 shrink-0" /> : children}
    </span>
  );
}
