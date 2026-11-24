import type { ComponentPropsWithoutRef } from "react";

import { cn } from "#src/lib/utils";
import { ActorAvatar } from "./actor-avatar";
import { AVATAR_STACK_RING } from "./avatar-stack-ring";

export const AVATAR_STACK_LIMIT = 3;

export function ActorAvatarStackMore({ more, label }: { more: number; label?: string }) {
  return (
    <span dir="ltr" className="inline-flex shrink-0">
      <ActorAvatar
        presence={false}
        size="xs"
        alt={label ?? ""}
        initials={`+${more}`}
        contentClassName={cn(
          "bg-avatar-more text-avatar-more-fg outline-none [&>span]:text-avatar-more-fg [&>span]:tabular-nums",
          more > 9 && "px-1",
          more > 99 && "px-1.5",
        )}
        className={cn(more > 9 && "[&&]:w-auto [&&]:min-w-6", AVATAR_STACK_RING.outline)}
      />
    </span>
  );
}

export function ActorAvatarStack({
  more = 0,
  moreLabel,
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<"span"> & {
  more?: number;
  moreLabel?: string;
}) {
  return (
    <span {...props} className={cn("flex items-center -space-x-1.5", className)}>
      {children}
      {more > 0 && <ActorAvatarStackMore more={more} label={moreLabel} />}
    </span>
  );
}
