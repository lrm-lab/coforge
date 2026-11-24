import type { ComponentType, SVGProps } from "react";

import { cn } from "#src/lib/utils";

type EmptyIconComponent = ComponentType<SVGProps<SVGSVGElement>>;

export function EmptyIcon({
  icon: Icon,
  size = "page",
  muted = false,
  className,
}: {
  icon: EmptyIconComponent;
  size?: "page" | "card";
  muted?: boolean;
  className?: string;
}) {
  const isCard = size === "card";
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center bg-secondary ring-1 ring-secondary ring-inset",
        isCard ? "size-10 rounded-lg" : "size-12 rounded-xl",
        muted ? "text-empty-muted" : "text-empty-accent",
        className,
      )}
    >
      <Icon
        aria-hidden="true"
        focusable="false"
        className={cn("shrink-0", isCard ? "size-5" : "size-6")}
      />
    </span>
  );
}
