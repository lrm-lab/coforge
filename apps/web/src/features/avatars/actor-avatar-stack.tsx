import type { ComponentPropsWithoutRef } from "react";

import { cn } from "#src/lib/utils";
import { ActorAvatar } from "./actor-avatar";
import { AVATAR_STACK_RING } from "./avatar-stack-ring";

const OVERLAP = { tight: "-space-x-1", loose: "-space-x-1.5" } as const;

export function ActorAvatarStack({
  overlap = "loose",
  ring = "regular",
  more = 0,
  moreLabel,
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<"span"> & {
  overlap?: keyof typeof OVERLAP;
  ring?: keyof typeof AVATAR_STACK_RING;
  more?: number;
  moreLabel?: string;
}) {
  return (
    <span {...props} className={cn("flex items-center", OVERLAP[overlap], className)}>
      {children}
      {more > 0 && (
        <span dir="ltr" className="inline-flex shrink-0">
          <ActorAvatar
            presence={false}
            size="xs"
            alt={moreLabel ?? ""}
            initials={`+${more}`}
            contentClassName={cn(
              "bg-avatar-more text-avatar-more-fg outline-none [&>span]:text-avatar-more-fg [&>span]:tabular-nums",
              more > 9 && "px-1",
              more > 99 && "px-1.5",
            )}
            className={cn(more > 9 && "[&&]:w-auto [&&]:min-w-6", AVATAR_STACK_RING[ring])}
          />
        </span>
      )}
    </span>
  );
}
