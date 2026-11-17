import type { ComponentPropsWithoutRef } from "react";

import { cn } from "#src/lib/utils";
import { ActorAvatar } from "./actor-avatar";
import { AVATAR_STACK_RING } from "./avatar-stack-ring";

const OVERLAP = { tight: "-space-x-1", loose: "-space-x-1.5" } as const;

export function ActorAvatarStack({
  overlap = "loose",
  ring = "regular",
  more = 0,
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<"span"> & {
  overlap?: keyof typeof OVERLAP;
  ring?: keyof typeof AVATAR_STACK_RING;
  more?: number;
}) {
  return (
    <span {...props} className={cn("flex items-center", OVERLAP[overlap], className)}>
      {children}
      {more > 0 && (
        <ActorAvatar
          presence={false}
          size="xs"
          alt=""
          initials={`+${more}`}
          contentClassName="bg-avatar-more text-avatar-more-fg outline-none [&>span]:text-avatar-more-fg [&>span]:tabular-nums"
          className={AVATAR_STACK_RING[ring]}
        />
      )}
    </span>
  );
}
